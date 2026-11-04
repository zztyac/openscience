import path from "node:path"
import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import z from "zod"
import { Global } from "@/global"
import { MaterialError } from "./store"

export const MATERIAL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024
const extensions = ["pdf", "txt", "md"] as const
const types = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown" } as const
const Record = z
  .object({
    version: z.literal(1),
    projectID: z.string().regex(/^mat_[a-f0-9]{32}$/),
    sourceID: z.string().regex(/^src_[a-f0-9]{32}$/),
    filename: z.string().min(1).max(180),
    extension: z.enum(extensions),
    size: z.number().int().positive().max(MATERIAL_UPLOAD_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export type MaterialUpload = {
  path: string
  filename: string
  mediaType: (typeof types)[keyof typeof types]
  size: number
}

function identities(projectID: string, sourceID: string) {
  if (!/^mat_[a-f0-9]{32}$/.test(projectID) || !/^src_[a-f0-9]{32}$/.test(sourceID))
    throw new MaterialError(400, "上传原件必须关联有效的科研项目和服务器文献编号")
}

function filename(input: string) {
  const base = path.posix.basename(input.replaceAll("\\", "/")).normalize("NFKC")
  const suffix = path.extname(base).slice(1).toLowerCase()
  const normalized = suffix === "markdown" ? "md" : suffix
  if (!extensions.some((extension) => extension === normalized))
    throw new MaterialError(400, "仅支持 PDF、TXT 或 Markdown 文献原件")
  const extension = normalized as (typeof extensions)[number]
  const name =
    base
      .slice(0, -(suffix.length + 1))
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 150)
      .trim() || "paper"
  return { filename: `${name}.${extension}`, extension }
}

function content(data: Uint8Array, extension: (typeof extensions)[number]) {
  if (data.byteLength > MATERIAL_UPLOAD_MAX_BYTES) throw new MaterialError(413, "单份文献原件不能超过 20 MB")
  if (!data.byteLength) throw new MaterialError(400, "文献原件不能为空")
  const pdf = new TextDecoder().decode(data.subarray(0, 5)) === "%PDF-"
  if (extension === "pdf") {
    if (!pdf) throw new MaterialError(400, "文件内容不是有效的 PDF 原件")
    return
  }
  if (pdf) throw new MaterialError(400, "PDF 原件必须使用 .pdf 扩展名")
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("binary")
  } catch {
    throw new MaterialError(400, "TXT 与 Markdown 原件必须是 UTF-8 文本，不能包含二进制内容")
  }
}

function digest(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

/** Original uploads are opaque, non-executable files; SQLite keeps only their source identity. */
export function materialUploads(directory = path.join(Global.Path.data, "materials")) {
  async function folder(projectID: string, create: boolean) {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const base = await fs.lstat(directory)
    if (!base.isDirectory() || base.isSymbolicLink()) throw new MaterialError(400, "上传原件目录无效")
    const root = await fs.realpath(directory)
    let current = directory
    for (const component of ["projects", projectID, "uploads"]) {
      current = path.join(current, component)
      if (create)
        await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
        })
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MaterialError(400, "上传原件目录无效")
      if (!(await fs.realpath(current)).startsWith(root + path.sep)) throw new MaterialError(400, "上传原件目录无效")
    }
    return current
  }

  async function read(projectID: string, sourceID: string): Promise<MaterialUpload | undefined> {
    identities(projectID, sourceID)
    try {
      const location = await folder(projectID, false)
      const metadata = path.join(location, `${sourceID}.json`)
      const meta = await fs.lstat(metadata)
      if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 4096) return undefined
      const parsed = Record.safeParse(await Bun.file(metadata).json())
      if (!parsed.success || parsed.data.projectID !== projectID || parsed.data.sourceID !== sourceID) return undefined
      const record = parsed.data
      const clean = filename(record.filename)
      if (clean.filename !== record.filename || clean.extension !== record.extension) return undefined
      const file = path.join(location, `${sourceID}.${record.extension}`)
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size || stat.mode & 0o111) return undefined
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
      content(bytes, record.extension)
      if (digest(bytes) !== record.sha256) return undefined
      return { path: file, filename: record.filename, mediaType: types[record.extension], size: record.size }
    } catch {
      return undefined
    }
  }

  return {
    read,
    async save(projectID: string, sourceID: string, file: File): Promise<MaterialUpload> {
      identities(projectID, sourceID)
      if (file.size > MATERIAL_UPLOAD_MAX_BYTES) throw new MaterialError(413, "单份文献原件不能超过 20 MB")
      const clean = filename(file.name)
      const bytes = new Uint8Array(await file.arrayBuffer())
      content(bytes, clean.extension)
      const location = await folder(projectID, true)
      const lock = path.join(location, `${sourceID}.lock`)
      const handle = await fs.open(lock, "wx", 0o600).catch(() => {
        throw new MaterialError(409, "该文献原件正在保存或已经存在")
      })
      await handle.close()
      const temporary = path.join(location, `.${sourceID}.${randomUUID()}.tmp`)
      const staged = `${temporary}.json`
      const target = path.join(location, `${sourceID}.${clean.extension}`)
      const metadata = path.join(location, `${sourceID}.json`)
      let published = false
      try {
        for (const name of [`${sourceID}.json`, ...extensions.map((extension) => `${sourceID}.${extension}`)]) {
          if (await fs.lstat(path.join(location, name)).catch(() => undefined))
            throw new MaterialError(409, "该文献原件已存在，不能覆盖")
        }
        await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
        const record = { version: 1, projectID, sourceID, ...clean, size: bytes.byteLength, sha256: digest(bytes) }
        await fs.writeFile(staged, JSON.stringify(record), { flag: "wx", mode: 0o600 })
        await folder(projectID, false)
        await fs.link(temporary, target)
        published = true
        await fs.link(staged, metadata)
        return { path: target, filename: clean.filename, mediaType: types[clean.extension], size: bytes.byteLength }
      } catch (error) {
        if (published) await fs.unlink(target).catch(() => {})
        if (error instanceof MaterialError) throw error
        throw new MaterialError(400, "无法保存文献原件，请检查本地存储后重试")
      } finally {
        await Promise.all([temporary, staged, lock].map((file) => fs.unlink(file).catch(() => {})))
      }
    },
    async remove(projectID: string, sourceID: string): Promise<void> {
      identities(projectID, sourceID)
      const location = await folder(projectID, false).catch(() => undefined)
      if (!location) return
      // Only server-derived names are ever removed, even when metadata is corrupt.
      await Promise.all(
        [`${sourceID}.json`, ...extensions.map((extension) => `${sourceID}.${extension}`)].map((file) =>
          fs.unlink(path.join(location, file)).catch(() => {}),
        ),
      )
    },
  }
}
