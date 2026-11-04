import path from "node:path"
import fs from "node:fs/promises"
import z from "zod"
import {
  MaterialLibrarySnapshot,
  type MaterialArtifact,
  type MaterialLibraryFile,
  type MaterialProject,
} from "@synsci/util/materials"
import { ArtifactStore } from "@/artifact/store"
import { Bus } from "@/bus"
import { File } from "@/file"
import { SafeFileIO } from "@/file/safe-io"
import { FileWatcher } from "@/file/watcher"
import { Global } from "@/global"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { AuthoritySignal } from "@/project/authority-signal"
import { Instance } from "@/project/instance"
import { Project } from "@/project/project"
import { Session } from "@/session"
import { SessionFilesystem } from "@/session/filesystem"
import { Storage } from "@/storage/storage"
import { FileLease } from "@/util/file-lease"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import { cachedMaterialPDF } from "./fulltext"
import { materialUploads } from "./uploads"

const Receipt = z.object({ resultID: z.string(), resultVersionID: z.string(), sha256: z.string() })
const Record = MaterialLibrarySnapshot.extend({
  schemaVersion: z.literal(1),
  owned: z.record(z.string(), z.string()),
  results: z.record(z.string(), Receipt),
})
type Record = z.infer<typeof Record>
const MAX_FILE = 32 * 1024 * 1024
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const segment = (value: string) => (/^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : hash(value).slice(0, 24))
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function location(project: MaterialProject) {
  if (!/^mat_[a-f0-9]{32}$/.test(project.id)) throw new Error("Invalid materials project identity")
  return path.join(Global.Path.data, "materials", "projects", project.id, "library.json")
}

// The managed data-root link is intentional; descendants must still pass no-follow IO.
async function physical(filepath: string) {
  if (!Filesystem.contains(Global.Path.data, filepath)) throw new Error("Invalid internal library path")
  return path.join(await fs.realpath(Global.Path.data), path.relative(Global.Path.data, filepath))
}

async function read(project: MaterialProject) {
  const file = await SafeFileIO.optional(await physical(location(project)), { maxBytes: 10 * 1024 * 1024 })
  if (!file) return
  const record = Record.parse(JSON.parse(file.bytes.toString("utf8")))
  if (record.materialsProjectID !== project.id || record.sessionID !== project.sessionID)
    throw new Error("Material library ownership changed")
  return record
}

async function persist(project: MaterialProject, record: Record) {
  const target = await physical(location(project))
  const previous = await SafeFileIO.optional(target, { maxBytes: 10 * 1024 * 1024 })
  await SafeFileIO.write(target, json(Record.parse(record)), previous)
}

function empty(project: MaterialProject): Record {
  return {
    schemaVersion: 1,
    materialsProjectID: project.id,
    sessionID: project.sessionID,
    status: project.sessionID ? "pending" : "unbound",
    files: [],
    warnings: [],
    owned: {},
    results: {},
    ...(!project.sessionID ? { message: "此课题尚未关联原会话，不能推测文件应归属的项目。" } : {}),
  }
}

/** Reading the library never launches a sync or changes the research state. */
export async function getMaterialLibrary(project: MaterialProject): Promise<MaterialLibrarySnapshot> {
  try {
    await using operation = await DataRootBarrier.enter(location(project))
    return await operation.during(async () => {
      const stored = await read(project)
      return MaterialLibrarySnapshot.parse({
        ...(stored ?? empty(project)),
        ...(stored?.revision !== undefined && stored.revision < project.revision && stored.status === "synced"
          ? { status: "pending" }
          : {}),
      })
    })
  } catch {
    return MaterialLibrarySnapshot.parse({
      ...empty(project),
      status: "error",
      message: "文件同步记录无法读取或归属信息不一致；请检查本地存储，现有文件未被修改。",
    })
  }
}

async function owner(project: MaterialProject, previous: Record) {
  if (!project.sessionID) return
  const keys = previous.projectID
    ? [["session", previous.projectID, project.sessionID]]
    : (await Storage.list(["session"])).filter((key) => key.length === 3 && key[2] === project.sessionID)
  if (keys.length !== 1) return
  const info = Session.Info.safeParse(await Storage.read(keys[0]).catch(() => undefined))
  if (!info.success || info.data.id !== project.sessionID || info.data.projectID !== keys[0][1]) return
  const resolved = await Project.resolve(info.data.projectID, info.data.directory)
  if (previous.directory && previous.directory !== resolved.directory) return
  return { projectID: resolved.project.id, directory: resolved.directory, sessionID: info.data.id }
}

function publicError(error: unknown) {
  if (SessionFilesystem.DeniedError.isInstance(error)) return "输出目录的读写授权已失效，请重新连接该目录后同步。"
  if (error instanceof ArtifactStore.CapacityError) return "可用磁盘空间不足，未能保存全部成果。"
  if (error instanceof ArtifactStore.LimitError || error instanceof SafeFileIO.LimitError)
    return "文件超过保存大小限制，未能同步。"
  return "文件或成果保存失败，请检查目录权限、磁盘空间后重新同步。"
}

/** Use the same revocable file authority and no-follow writes as the file broker. */
async function write(
  record: Record,
  relative: string,
  content: string | Uint8Array,
): Promise<{ path: string; conflict: boolean }> {
  const target = path.join(record.root!, relative)
  if (!Filesystem.contains(record.root!, target)) throw new Error("Invalid library destination")
  const authorized = await SessionFilesystem.authorize({ sessionID: record.sessionID!, path: target, access: "write" })
  if (authorized.path !== target) throw new Error("Library destination was redirected")
  const binding = await SessionFilesystem.bindAuthorization({
    sessionID: record.sessionID!,
    access: "write",
    authorized,
  })
  const digest = hash(content)
  try {
    const changed = await AuthoritySignal.exclusive(async () => {
      const current = await SessionFilesystem.revalidateAuthorization(binding, { path: target, access: "write" })
      if (current.path !== target) throw new Error("Library destination was redirected")
      const previous = await SafeFileIO.optional(target, { maxBytes: MAX_FILE })
      const previousHash = previous && hash(previous.bytes)
      if (previousHash === digest) return "same" as const
      if (previous && previousHash !== record.owned[relative]) return "conflict" as const
      await SafeFileIO.write(target, content, previous)
      return previous ? ("change" as const) : ("add" as const)
    })
    if (changed === "conflict") return { path: target, conflict: true }
    record.owned[relative] = digest
    if (changed !== "same") {
      await Bus.publish(File.Event.Edited, { file: target })
      await Bus.publish(FileWatcher.Event.Updated, { file: target, event: changed })
    }
    return { path: target, conflict: false }
  } finally {
    SessionFilesystem.releaseAuthorization(binding)
  }
}

async function publish(project: MaterialProject, record: Record, artifact: MaterialArtifact, format: "md" | "json") {
  const key = `${artifact.id}:${format}`
  const content = format === "md" ? artifact.markdown : json(artifact.data)
  const digest = hash(content)
  const prior = record.results[key]
  if (prior?.sha256 === digest) {
    const stored = await ArtifactStore.read(record.projectID!, prior.resultID, prior.resultVersionID)
    if (stored?.info.sha256 === digest) {
      const latest = project.artifacts.findLast((item) => item.stage === artifact.stage)?.id === artifact.id
      const current = latest ? await ArtifactStore.get(record.projectID!, prior.resultID) : undefined
      // Repairing an older blob may have changed Results.current; the latest report must restore it.
      if (!latest || current?.currentVersionID === prior.resultVersionID) return prior
    }
  }
  const sourcePath = `materials/${project.id}/reports/${artifact.stage}.${format}`
  // A crash after the immutable save but before our receipt must not add a duplicate version.
  const candidates = [
    ...(await ArtifactStore.list(record.projectID!)),
    ...(await ArtifactStore.list(record.projectID!, "trash")),
  ]
  const existing = candidates.find((item) => item.current.sourcePath === sourcePath)
  const detail = existing ? await ArtifactStore.get(record.projectID!, existing.id) : undefined
  const matching =
    detail?.current.sha256 === digest &&
    detail.current.sessionID === record.sessionID &&
    detail.execution?.inputs?.materialArtifactID === artifact.id &&
    (await ArtifactStore.read(record.projectID!, detail.id, detail.currentVersionID))?.info.sha256 === digest
  const saved = matching
    ? detail
    : await ArtifactStore.save({
        projectID: record.projectID!,
        sessionID: record.sessionID!,
        sourcePath,
        filename: `${artifact.stage}.${format}`,
        kind: format === "md" ? "report" : "dataset",
        title: `${project.title} · ${artifact.title}${format === "json" ? "（结构化数据）" : ""}`,
        mimeType: format === "md" ? "text/markdown" : "application/json",
        content: new Blob([content]),
        captureQuality: "declared",
        execution: {
          status: "succeeded",
          source: "materials_workflow",
          captureQuality: "declared",
          files: [],
          inputs: {
            materialsProjectID: project.id,
            materialArtifactID: artifact.id,
            stage: artifact.stage,
            version: artifact.version,
            inputArtifactIDs: artifact.inputArtifactIDs,
          },
        },
      })
  const receipt = { resultID: saved.id, resultVersionID: saved.currentVersionID, sha256: digest }
  record.results[key] = receipt
  await persist(project, record)
  return receipt
}

function csv(project: MaterialProject["batches"][number]) {
  const columns = [
    "sampleID",
    "groupID",
    "property",
    "value",
    "unit",
    "temperatureK",
    "fieldT",
    "angleDeg",
    "process",
    "notes",
  ] as const
  const cell = (value: unknown) => (value === undefined ? "" : `"${String(value).replaceAll('"', '""')}"`)
  return `${columns.join(",")}\n${project.measurements.map((row) => columns.map((key) => cell(row[key])).join(",")).join("\n")}\n`
}

/** Publish exact stored research records; this bridge never runs a model or changes a material artifact. */
export async function syncMaterialLibrary(project: MaterialProject): Promise<MaterialLibrarySnapshot> {
  const metadata = location(project)
  using lock = await Lock.write(metadata)
  try {
    await using lease = await FileLease.acquire(`${metadata}.sync`)
    return await lease.during(() => synchronize(project))
  } catch {
    return MaterialLibrarySnapshot.parse({
      ...empty(project),
      status: "error",
      message: "文件同步记录无法读取或归属信息不一致；请检查本地存储，现有文件未被修改。",
    })
  }
}

async function synchronize(project: MaterialProject): Promise<MaterialLibrarySnapshot> {
  const previous = await read(project)
  if (previous?.revision !== undefined && previous.revision > project.revision)
    return MaterialLibrarySnapshot.parse(previous)
  const record = previous ?? empty(project)
  try {
    const identity = await owner(project, record)
    if (!identity) {
      record.status = "unbound"
      record.message = "未找到此课题唯一对应的原会话；未将文件绑定到其他项目。"
      record.updatedAt = Date.now()
      await persist(project, record)
      return MaterialLibrarySnapshot.parse(record)
    }
    return await Instance.provide({
      ...identity,
      fn: async () => {
        const session = await Session.get(identity.sessionID)
        if (session.projectID !== identity.projectID) throw new Error("Material session project mismatch")
        const filesystem = await SessionFilesystem.snapshot(session.id)
        const root = record.root ?? path.join(filesystem.toolDirectory, "materials", project.id)
        if (path.basename(root) !== project.id || path.basename(path.dirname(root)) !== "materials")
          throw new Error("Invalid library root")
        const authorized = await SessionFilesystem.authorize({ sessionID: session.id, path: root, access: "write" })
        if (authorized.path !== root) throw new Error("Library root was redirected")
        Object.assign(record, identity, {
          root,
          location:
            record.location ?? (filesystem.toolDirectory === filesystem.workspace.scratchRoot ? "scratch" : "working"),
          status: "syncing",
          revision: project.revision,
          updatedAt: Date.now(),
          files: [],
          warnings: [],
          message: undefined,
        })
        await persist(project, record)
        const warnings = new Set<string>()
        const textOnly: string[] = []
        const add = async (relative: string, content: string | Uint8Array, info: Omit<MaterialLibraryFile, "path">) => {
          try {
            const file = await write(record, relative, content)
            record.files.push({ ...info, path: file.path })
            if (file.conflict) warnings.add(`已保留人工修改的文件：${relative}`)
          } catch (error) {
            warnings.add(`${relative}：${publicError(error)}`)
          }
        }
        for (const source of project.sources) {
          const base = `papers/${segment(source.id)}`
          await add(`${base}.json`, json(source), {
            kind: "paper",
            title: `${source.title}（证据与元数据）`,
            mimeType: "application/json",
            sourceID: source.id,
          })
          await add(`${base}.txt`, source.text, {
            kind: "paper",
            title: `${source.title}（${{ fulltext: "全文", partial: "部分正文", abstract: "摘要", note: "笔记" }[source.kind]}文本）`,
            mimeType: "text/plain",
            sourceID: source.id,
          })
          try {
            const uploaded =
              source.origin === "upload" ? await materialUploads().read(project.id, source.id) : undefined
            const cached = uploaded ? undefined : await cachedMaterialPDF(source, { projectID: project.id })
            const original = uploaded?.path ?? cached
            if (original) {
              const content = await SafeFileIO.read(await physical(original), { maxBytes: MAX_FILE })
              const type = uploaded?.mediaType ?? "application/pdf"
              const extension = type === "application/pdf" ? "pdf" : type === "text/markdown" ? "md" : "txt"
              await add(`${base}.original.${extension}`, content.bytes, {
                kind: "paper",
                title: `${source.title}（原始文件）`,
                mimeType: type,
                sourceID: source.id,
              })
            } else if (source.origin === "upload") {
              // Pasted text and historical PDF extraction share origin=upload.
              // The absence of an attachment is not a failed file transfer.
              textOnly.push(source.title.slice(0, 100))
            }
          } catch (error) {
            warnings.add(`${source.title.slice(0, 100)} 原件：${publicError(error)}`)
          }
        }
        for (const batch of project.batches) {
          const base = `data/${segment(batch.id)}`
          await add(`${base}.json`, json(batch), {
            kind: "data",
            title: `${batch.name}（测量记录）`,
            mimeType: "application/json",
            batchID: batch.id,
          })
          await add(`${base}.csv`, batch.rawCSV ?? csv(batch), {
            kind: "data",
            title: `${batch.name}（表格）`,
            mimeType: "text/csv",
            batchID: batch.id,
          })
        }
        for (const artifact of project.artifacts) {
          for (const format of ["md", "json"] as const) {
            const content = format === "md" ? artifact.markdown : json(artifact.data)
            const receipt = await publish(project, record, artifact, format).catch((error) => {
              warnings.add(`${artifact.title}成果登记：${publicError(error)}`)
              return undefined
            })
            const info: Omit<MaterialLibraryFile, "path"> = {
              kind: "report",
              title: `${artifact.title} · v${artifact.version}${format === "json" ? "（数据）" : ""}`,
              mimeType: format === "md" ? "text/markdown" : "application/json",
              materialArtifactID: artifact.id,
              ...(receipt ? { resultID: receipt.resultID, resultVersionID: receipt.resultVersionID } : {}),
            }
            await add(`reports/${artifact.stage}/v${artifact.version}.${format}`, content, info)
            if (project.artifacts.findLast((item) => item.stage === artifact.stage)?.id === artifact.id)
              await add(`reports/${artifact.stage}.${format}`, content, {
                ...info,
                title: `${artifact.title}（最新${format === "json" ? "数据" : "报告"}）`,
              })
          }
        }
        await add("data/research.json", json(project), {
          kind: "data",
          title: "完整研究记录",
          mimeType: "application/json",
        })
        const readme = `# ${project.title}\n\n课题编号：${project.id}\n\n## 研究目标\n\n${project.goal}\n\n## 文件说明\n\n- papers：文献元数据、已获得的证据文本及可用的论文原件；缺少原件不表示已有全文。\n- data：测量数据和完整研究记录。\n- reports：各阶段报告、结构化数据与历史版本。\n\n原始科研记录保存在平台数据库；此目录是文件副本。手动修改不会反写数据库，后续同步会保留已识别的人工修改。阶段成果同时保存到原项目的成果库，保留不可变版本。\n${textOnly.length ? `\n## 仅保存文本的资料\n\n以下资料没有关联原始附件，已归档现有文本。直接粘贴的资料本来就没有附件；旧版本未保存的上传原件无法恢复。\n\n${textOnly.map((title) => `- ${title}`).join("\n")}\n` : ""}`
        await add("README.md", readme, { kind: "index", title: "材料课题文件说明", mimeType: "text/markdown" })
        record.warnings = [...warnings]
        record.status = warnings.size ? "partial" : "synced"
        record.updatedAt = Date.now()
        record.message = warnings.size
          ? "已同步可保存的文件；部分文件需要处理，已保留已有科研成果。"
          : "论文、数据与报告已同步到原会话文件空间，阶段报告已保存到成果库。"
        await persist(project, record)
        return MaterialLibrarySnapshot.parse(record)
      },
    })
  } catch (error) {
    record.status = "error"
    record.updatedAt = Date.now()
    record.message = publicError(error)
    await persist(project, record).catch(() => undefined)
    return MaterialLibrarySnapshot.parse(record)
  }
}
