import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { MATERIAL_UPLOAD_MAX_BYTES, materialUploads } from "../../src/materials/uploads"
import { tinyPDF } from "../science/fixtures/tiny-pdf"

const projectID = `mat_${"1".repeat(32)}`
const sourceID = `src_${"2".repeat(32)}`
const otherID = `src_${"3".repeat(32)}`
const roots: string[] = []
const pdf = Uint8Array.from(tinyPDF(["Uploaded source for a REBCO film study."]))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "materials-uploads-"))
  roots.push(root)
  const directory = path.join(root, "materials")
  return { root, directory, uploads: materialUploads(directory) }
}

test("PDF originals are stored under server IDs with safe filenames and non-executable permissions", async () => {
  const { directory, uploads } = await fixture()
  const saved = await uploads.save(
    projectID,
    sourceID,
    new File([pdf], "../../papers/超导薄膜.PDF", { type: "application/x-executable" }),
  )
  expect(saved).toEqual({
    path: path.join(directory, "projects", projectID, "uploads", `${sourceID}.pdf`),
    filename: "超导薄膜.pdf",
    mediaType: "application/pdf",
    size: pdf.length,
  })
  expect((await fs.stat(saved.path)).mode & 0o777).toBe(0o600)
  expect(new Uint8Array(await Bun.file(saved.path).arrayBuffer())).toEqual(pdf)
  expect(await uploads.read(projectID, sourceID)).toEqual(saved)
  expect(await uploads.read(projectID, otherID)).toBeUndefined()
  const metadata = await Bun.file(path.join(path.dirname(saved.path), `${sourceID}.json`)).json()
  expect(metadata).toMatchObject({ projectID, sourceID, extension: "pdf", size: pdf.length })
  expect(JSON.stringify(metadata)).not.toContain("base64")
  expect(JSON.stringify(metadata)).not.toContain(directory)
})

for (const [name, type] of [
  ["paper.txt", "text/plain"],
  ["实验方案.md", "text/markdown"],
  ["论文原文.markdown", "text/markdown"],
] as const) {
  test(`retains UTF-8 ${name} unchanged`, async () => {
    const { uploads } = await fixture()
    const text = "# REBCO 材料研究\n磁通钉扎机制与临界电流密度\n"
    const saved = await uploads.save(projectID, sourceID, new File([text], name))
    expect(saved.mediaType).toBe(type)
    if (name.endsWith(".markdown")) expect(saved.filename).toBe("论文原文.md")
    expect(await Bun.file(saved.path).text()).toBe(text)
    expect(await uploads.read(projectID, sourceID)).toEqual(saved)
  })
}

for (const [name, bytes, message] of [
  ["paper.html", new TextEncoder().encode("<html>paper</html>"), "仅支持"],
  ["paper.pdf", new TextEncoder().encode("<html>Please verify your browser</html>"), "不是有效"],
  ["paper.txt", pdf, "扩展名"],
  ["paper.md", new Uint8Array([0xff, 0xfe, 0x00, 0x01]), "UTF-8"],
  ["paper.txt", new TextEncoder().encode("binary\0payload"), "二进制"],
  ["paper.txt", new Uint8Array(), "不能为空"],
] as const) {
  test(`rejects ${name} with invalid extension or content (${message})`, async () => {
    const { directory, uploads } = await fixture()
    await expect(uploads.save(projectID, sourceID, new File([Uint8Array.from(bytes)], name))).rejects.toThrow(message)
    expect(await Bun.file(path.join(directory, "projects", projectID, "uploads", `${sourceID}.json`)).exists()).toBe(
      false,
    )
  })
}

test("rejects originals larger than 20 MB before creating their storage", async () => {
  const { directory, uploads } = await fixture()
  const file = new File([new Uint8Array(MATERIAL_UPLOAD_MAX_BYTES + 1)], "paper.pdf")
  await expect(uploads.save(projectID, sourceID, file)).rejects.toMatchObject({ status: 413 })
  expect(await fs.stat(directory).catch(() => undefined)).toBeUndefined()
})

test("invalid IDs cannot address upload files or traverse directories", async () => {
  const { uploads } = await fixture()
  for (const [project, source] of [
    ["../outside", sourceID],
    [projectID, "../../secret"],
    [projectID, "src_user-chosen-name"],
  ]) {
    await expect(uploads.save(project, source, new File([pdf], "paper.pdf"))).rejects.toMatchObject({ status: 400 })
    await expect(uploads.read(project, source)).rejects.toMatchObject({ status: 400 })
    await expect(uploads.remove(project, source)).rejects.toMatchObject({ status: 400 })
  }
})

test("existing originals are immutable and concurrent saves cannot overwrite one another", async () => {
  const { uploads } = await fixture()
  const results = await Promise.allSettled([
    uploads.save(projectID, sourceID, new File([pdf], "first.pdf")),
    uploads.save(projectID, sourceID, new File(["Other content"], "second.txt")),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  const original = await uploads.read(projectID, sourceID)
  expect(original).toBeDefined()
  await expect(uploads.save(projectID, sourceID, new File([pdf], "replacement.pdf"))).rejects.toMatchObject({
    status: 409,
  })
  expect(await uploads.read(projectID, sourceID)).toEqual(original)
  expect(
    (await fs.readdir(path.dirname(original!.path))).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
  ).toBe(false)
})

test("rollback removes only the specified original and its metadata", async () => {
  const { uploads } = await fixture()
  const first = await uploads.save(projectID, sourceID, new File([pdf], "one.pdf"))
  const second = await uploads.save(projectID, otherID, new File(["second paper text"], "two.md"))
  await uploads.remove(projectID, sourceID)
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
  expect(await Bun.file(first.path).exists()).toBe(false)
  expect(await uploads.read(projectID, otherID)).toEqual(second)
})

test("metadata cannot redirect an original to another source or arbitrary path", async () => {
  const { uploads } = await fixture()
  const saved = await uploads.save(projectID, sourceID, new File([pdf], "one.pdf"))
  const metadata = path.join(path.dirname(saved.path), `${sourceID}.json`)
  const record = await Bun.file(metadata).json()
  await Bun.write(metadata, JSON.stringify({ ...record, sourceID: otherID }))
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
  await Bun.write(metadata, JSON.stringify({ ...record, path: "/etc/passwd" }))
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
  await Bun.write(metadata, JSON.stringify({ ...record, extension: "../../private" }))
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
})

test("changed bytes or executable permissions invalidate an original", async () => {
  const { uploads } = await fixture()
  const saved = await uploads.save(projectID, sourceID, new File(["Original text."], "paper.txt"))
  await fs.chmod(saved.path, 0o700)
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
  await fs.chmod(saved.path, 0o600)
  await Bun.write(saved.path, "Modified text.")
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
})

test("a parent symlink cannot redirect a new upload outside project storage", async () => {
  const { root, directory, uploads } = await fixture()
  const outside = path.join(root, "outside")
  await fs.mkdir(outside)
  await fs.mkdir(path.join(directory, "projects"), { recursive: true })
  await fs.symlink(outside, path.join(directory, "projects", projectID))
  await expect(uploads.save(projectID, sourceID, new File([pdf], "paper.pdf"))).rejects.toMatchObject({ status: 400 })
  expect(await fs.readdir(outside)).toEqual([])
})

test("replacing a saved upload directory with a symlink prevents later reading or deleting outside files", async () => {
  const { root, uploads } = await fixture()
  const saved = await uploads.save(projectID, sourceID, new File([pdf], "paper.pdf"))
  const directory = path.dirname(saved.path)
  const outside = path.join(root, "outside")
  await fs.rename(directory, outside)
  await fs.symlink(outside, directory)
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
  await uploads.remove(projectID, sourceID)
  expect(await Bun.file(path.join(outside, `${sourceID}.pdf`)).exists()).toBe(true)
})

test("a saved file symlink cannot expose a different PDF", async () => {
  const { root, uploads } = await fixture()
  const saved = await uploads.save(projectID, sourceID, new File([pdf], "paper.pdf"))
  const outside = path.join(root, "private.pdf")
  await Bun.write(outside, pdf)
  await fs.unlink(saved.path)
  await fs.symlink(outside, saved.path)
  expect(await uploads.read(projectID, sourceID)).toBeUndefined()
})
