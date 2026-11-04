import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Storage } from "../../src/storage/storage"
import { getMaterialLibrary, syncMaterialLibrary } from "../../src/materials/library"
import { MaterialsStore, materialID } from "../../src/materials/store"
import { materialUploads } from "../../src/materials/uploads"
import type { MaterialArtifact, MaterialProject } from "@synsci/util/materials"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await ArtifactStore.reset()
})

function project(sessionID?: string) {
  const store = new MaterialsStore(path.join(Global.Path.data, "materials"))
  const created = store.create(
    { goal: "提高 REBCO 薄膜的临界电流密度", requestID: crypto.randomUUID() },
    sessionID ? { sessionID } : undefined,
  )
  const result = store.update(created.id, created.revision, (next) => {
    next.status = "completed"
    next.sources.push({
      id: materialID("src"),
      title: "REBCO evidence",
      authors: "Researcher",
      kind: "abstract",
      text: "This abstract describes REBCO pinning and its limitations.",
      origin: "crossref",
      createdAt: 1,
    })
    next.artifacts.push(artifact(1))
  })
  store.close()
  return result
}

function artifact(version: number): MaterialArtifact {
  return {
    id: materialID("art"),
    stage: "strategies",
    title: "策略构建",
    version,
    createdAt: version,
    markdown: `# Strategy version ${version}\n\nGrounded scientific proposal.\n`,
    data: { version, strategy: "pinning" },
    inputArtifactIDs: [],
  }
}

async function record(value: MaterialProject) {
  const filepath = path.join(Global.Path.data, "materials", "projects", value.id, "library.json")
  return { filepath, value: await Bun.file(filepath).json() }
}

test("unbound libraries stay unbound and GET performs no export or project mutation", async () => {
  const value = project()
  const before = structuredClone(value)
  const pending = await getMaterialLibrary(value)
  expect(pending.status).toBe("unbound")
  expect(await Bun.file(path.join(Global.Path.data, "materials", "projects", value.id, "library.json")).exists()).toBe(
    false,
  )
  expect((await syncMaterialLibrary(value)).status).toBe("unbound")
  expect(value).toEqual(before)
  expect((await getMaterialLibrary({ ...value, sessionID: "ses_nonexistent" })).status).toBe("error")
})

test("a legacy session-only binding writes to its real scratch space and publishes exact durable Results", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const scratch = await SessionFilesystem.workspace(session.id)
      const value = project(session.id)
      const before = structuredClone(value)
      const snapshot = await syncMaterialLibrary(value)
      expect(snapshot).toMatchObject({
        status: "synced",
        projectID: session.projectID,
        sessionID: session.id,
        directory: tmp.path,
        location: "scratch",
        root: path.join(scratch, "materials", value.id),
        revision: value.revision,
      })
      expect(value).toEqual(before)
      expect(
        snapshot.files.every((file) => path.isAbsolute(file.path) && file.path.startsWith(snapshot.root! + path.sep)),
      ).toBe(true)
      expect(snapshot.files.filter((file) => file.sourceID === value.sources[0].id)).toHaveLength(2)
      const output = snapshot.files.find((file) => file.path.endsWith("reports/strategies.md"))!
      expect(await Bun.file(output.path).text()).toBe(value.artifacts[0].markdown)
      expect(output.resultID).toBeString()
      expect(
        await (await ArtifactStore.read(session.projectID, output.resultID!, output.resultVersionID))!.content.text(),
      ).toBe(value.artifacts[0].markdown)
      expect(await ArtifactStore.list(session.projectID)).toHaveLength(2)
      const details = await ArtifactStore.get(session.projectID, output.resultID!)
      expect(details?.execution?.inputs).toMatchObject({
        materialsProjectID: value.id,
        materialArtifactID: value.artifacts[0].id,
      })
      const again = await syncMaterialLibrary(value)
      expect(again.status).toBe("synced")
      expect((await ArtifactStore.get(session.projectID, output.resultID!))?.versionCount).toBe(1)
      expect((await getMaterialLibrary(value)).files).toEqual(again.files)
    },
  })
})

test("connected working roots stay pinned and revocation cannot silently redirect or continue writes", async () => {
  await using tmp = await tmpdir()
  await using first = await tmpdir()
  await using second = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const grant = await SessionFilesystem.connectProject({ path: first.path, access: "write" })
      const session = await Session.create({})
      const value = project(session.id)
      const initial = await syncMaterialLibrary(value)
      expect(initial.status).toBe("synced")
      expect(initial.location).toBe("working")
      expect(initial.root).toBe(path.join(first.path, "materials", value.id))
      await SessionFilesystem.connectProject({ path: second.path, access: "write" })
      await SessionFilesystem.setWorkingRoot(session.id, second.path)
      expect((await syncMaterialLibrary({ ...value, revision: value.revision + 1 })).root).toBe(initial.root)
      expect(await fs.stat(path.join(second.path, "materials", value.id)).catch(() => undefined)).toBeUndefined()
      await SessionFilesystem.revokeProject(grant.id)
      const revoked = await syncMaterialLibrary({ ...value, revision: value.revision + 2 })
      expect(revoked.status).toBe("error")
      expect(revoked.message).toContain("授权")
      expect(revoked.root).toBe(initial.root)
    },
  })
})

test("read-only source folders are never selected as output roots", async () => {
  await using tmp = await tmpdir()
  await using source = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SessionFilesystem.connectProject({ path: source.path, access: "read" })
      const session = await Session.create({})
      const value = project(session.id)
      const result = await syncMaterialLibrary(value)
      expect(result.status).toBe("synced")
      expect(result.location).toBe("scratch")
      expect(result.root?.startsWith(source.path)).toBe(false)
      expect(await fs.readdir(source.path)).toEqual([])
    },
  })
})

test("new research versions preserve human edits while immutable Results retain the actual stored research", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const value = project(session.id)
      const initial = await syncMaterialLibrary(value)
      const original = initial.files.find((file) => file.path.endsWith("reports/strategies.md"))!
      const history = initial.files.find((file) => file.path.endsWith("reports/strategies/v1.md"))!
      await Bun.write(original.path, "My manual revision\n")
      await Bun.write(history.path, "My historical annotation\n")
      const next = { ...value, revision: value.revision + 1, artifacts: [...value.artifacts, artifact(2)] }
      const result = await syncMaterialLibrary(next)
      expect(result.status).toBe("partial")
      expect(result.warnings.some((warning) => warning.includes("人工修改"))).toBe(true)
      expect(await Bun.file(original.path).text()).toBe("My manual revision\n")
      expect(await Bun.file(history.path).text()).toBe("My historical annotation\n")
      const latest = result.files.find((file) => file.path.endsWith("reports/strategies.md"))!
      expect(latest.resultID).toBe(original.resultID)
      expect((await ArtifactStore.get(session.projectID, latest.resultID!))?.versionCount).toBe(2)
      expect(
        await (await ArtifactStore.read(session.projectID, latest.resultID!, latest.resultVersionID))!.content.text(),
      ).toBe(next.artifacts[1].markdown)
      expect(
        await (await ArtifactStore.read(
          session.projectID,
          original.resultID!,
          original.resultVersionID,
        ))!.content.text(),
      ).toBe(value.artifacts[0].markdown)
      expect(await Bun.file(path.join(result.root!, "reports/strategies/v2.md")).text()).toBe(
        next.artifacts[1].markdown,
      )
    },
  })
})

test("concurrent syncs and interrupted receipt writes do not duplicate Results or roll back revisions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const value = project(session.id)
      const [first, second] = await Promise.all([syncMaterialLibrary(value), syncMaterialLibrary(value)])
      expect(first.status).toBe("synced")
      expect(second.status).toBe("synced")
      const saved = second.files.find((file) => file.path.endsWith("reports/strategies.md"))!
      const metadata = await record(value)
      metadata.value.results = {}
      metadata.value.status = "syncing"
      await Bun.write(metadata.filepath, JSON.stringify(metadata.value))
      expect((await syncMaterialLibrary(value)).status).toBe("synced")
      expect((await ArtifactStore.get(session.projectID, saved.resultID!))?.versionCount).toBe(1)
      const next = { ...value, revision: value.revision + 10, artifacts: [...value.artifacts, artifact(2)] }
      const newest = await syncMaterialLibrary(next)
      expect((await syncMaterialLibrary(value)).revision).toBe(next.revision)
      expect(await Bun.file(path.join(newest.root!, "reports/strategies.md")).text()).toBe(next.artifacts[1].markdown)
    },
  })
})

test("uploaded original bytes and measurements are available as ordinary files", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const value = project(session.id)
      value.sources[0].origin = "upload"
      const bytes = "%PDF-1.7\nfixture-original-pdf\n%%EOF"
      await materialUploads().save(
        value.id,
        value.sources[0].id,
        new globalThis.File([bytes], "paper.pdf", { type: "application/pdf" }),
      )
      value.batches.push({
        id: materialID("batch"),
        protocolID: "protocol-one",
        name: "Real measurement",
        createdAt: 1,
        measurements: [
          {
            sampleID: "S1",
            groupID: "control",
            property: "Jc",
            value: 2,
            unit: "MA/cm2",
            temperatureK: 77,
            fieldT: 1,
            process: "PLD",
            notes: "measured",
          },
        ],
      })
      const result = await syncMaterialLibrary(value)
      expect(result.status).toBe("synced")
      const pdf = result.files.find((file) => file.mimeType === "application/pdf")!
      expect(await Bun.file(pdf.path).text()).toBe(bytes)
      const batch = result.files.find(
        (file) => file.batchID === value.batches[0].id && file.mimeType === "application/json",
      )!
      expect(await Bun.file(batch.path).json()).toEqual(value.batches[0])
      const table = result.files.find((file) => file.batchID === value.batches[0].id && file.mimeType === "text/csv")!
      expect(await Bun.file(table.path).text()).toContain('"S1","control","Jc","2","MA/cm2","77","1"')
    },
  })
})

test("a symlinked output subdirectory cannot redirect writes even within an otherwise authorized root", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const scratch = await SessionFilesystem.workspace(session.id)
      const value = project(session.id)
      const root = path.join(scratch, "materials", value.id)
      const unrelated = path.join(scratch, "user-files")
      await fs.mkdir(root, { recursive: true })
      await fs.mkdir(unrelated)
      await fs.symlink(unrelated, path.join(root, "reports"))
      const result = await syncMaterialLibrary(value)
      expect(result.status).toBe("partial")
      expect(await fs.readdir(unrelated)).toEqual([])
      expect((await ArtifactStore.list(session.projectID)).length).toBe(2)
    },
  })
})

test("a missing or duplicated session identity never attaches the material project to the current page", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const missing = project("ses_missing")
      expect((await syncMaterialLibrary(missing)).status).toBe("unbound")
      const value = project(session.id)
      const key = ["session", "prj_ambiguous", session.id]
      await Storage.write(key, { ...session, projectID: "prj_ambiguous" })
      try {
        expect((await syncMaterialLibrary(value)).status).toBe("unbound")
        expect(await ArtifactStore.list(session.projectID)).toHaveLength(0)
      } finally {
        await Storage.remove(key)
      }
    },
  })
})

test("Markdown originals retain their extension and text-only sources remain successful with an honest index", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const value = project(session.id)
      value.sources[0].origin = "upload"
      const markdown = { ...value.sources[0], id: materialID("src"), title: "Research notes", kind: "note" as const }
      value.sources.push(markdown)
      const text = "# Original research notes\n\nObserved pinning defects.\n"
      await materialUploads().save(
        value.id,
        markdown.id,
        new globalThis.File([text], "notes.markdown", { type: "text/markdown" }),
      )
      const result = await syncMaterialLibrary(value)
      expect(result.status).toBe("synced")
      expect(result.warnings).toEqual([])
      const index = result.files.find((item) => item.kind === "index")!
      expect(await Bun.file(index.path).text()).toContain("没有关联原始附件")
      expect(await Bun.file(index.path).text()).toContain(value.sources[0].title)
      const file = result.files.find((item) => item.sourceID === markdown.id && item.mimeType === "text/markdown")!
      expect(file.path.endsWith(".original.md")).toBe(true)
      expect(await Bun.file(file.path).text()).toBe(text)
      expect(
        result.files.find((item) => item.sourceID === markdown.id && item.mimeType === "text/plain")?.title,
      ).toContain("笔记")
      expect(
        result.files.find((item) => item.sourceID === value.sources[0].id && item.mimeType === "text/plain")?.title,
      ).toContain("摘要")
    },
  })
})

test("corrupt library records are visible errors and cannot reset the pinned ownership or modify exports", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const value = project(session.id)
      const synced = await syncMaterialLibrary(value)
      const file = synced.files.find((item) => item.path.endsWith("reports/strategies.md"))!
      const metadata = await record(value)
      await Bun.write(metadata.filepath, "{ incomplete metadata")
      expect((await getMaterialLibrary(value)).status).toBe("error")
      expect((await syncMaterialLibrary(value)).status).toBe("error")
      expect(await Bun.file(metadata.filepath).text()).toBe("{ incomplete metadata")
      expect(await Bun.file(file.path).text()).toBe(value.artifacts[0].markdown)
      expect((await ArtifactStore.get(session.projectID, file.resultID!))?.versionCount).toBe(1)
    },
  })
})

test("missing or corrupt Results bytes are repaired and repairing history keeps the newest report current", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const value = project(session.id)
      value.artifacts.push(artifact(2))
      const initial = await syncMaterialLibrary(value)
      const latest = initial.files.find((item) => item.path.endsWith("reports/strategies.md"))!
      const history = initial.files.find((item) => item.path.endsWith("reports/strategies/v1.md"))!
      const previous = await ArtifactStore.read(session.projectID, history.resultID!, history.resultVersionID)
      await fs.unlink(previous!.content.name!)
      expect((await syncMaterialLibrary(value)).status).toBe("synced")
      expect(await (await ArtifactStore.read(session.projectID, latest.resultID!))!.content.text()).toBe(
        value.artifacts[1].markdown,
      )
      const current = await ArtifactStore.read(session.projectID, latest.resultID!)
      await Bun.write(current!.content.name!, "corrupt bytes")
      const recovered = await syncMaterialLibrary(value)
      expect(recovered.status).toBe("synced")
      expect(await (await ArtifactStore.read(session.projectID, latest.resultID!))!.content.text()).toBe(
        value.artifacts[1].markdown,
      )
      const versionCount = (await ArtifactStore.get(session.projectID, latest.resultID!))!.versionCount
      await syncMaterialLibrary(value)
      expect((await ArtifactStore.get(session.projectID, latest.resultID!))!.versionCount).toBe(versionCount)
    },
  })
})
