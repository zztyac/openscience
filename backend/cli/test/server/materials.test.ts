import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createMaterialsRoutes } from "../../src/server/routes/materials"
import { MaterialsService, disposeMaterialsService } from "../../src/materials/workflow"
import { MaterialActivitySnapshot, type MaterialProject } from "@synsci/util/materials"

const disposals: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
})
function app() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "materials-api-"))
  const service = new MaterialsService({
    directory,
    executor: async (_project, stage, signal) => {
      if (stage !== "intake") throw new Error("Literature search unavailable in this test")
      await Bun.sleep(20)
      signal.throwIfAborted()
      return {
        title: "研究目标",
        markdown: "# 研究目标",
        data: {
          title: "REBCO study",
          materialSystem: "REBCO",
          objective: "Improve Jc",
          constraints: [],
          searchQueries: ["REBCO"],
          questions: ["目标温度？"],
          target: "protocol",
        },
      }
    },
  })
  disposals.push(() => {
    service.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return new Hono().route("/materials", createMaterialsRoutes(service))
}
const request = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
const input = { goal: "提高 REBCO 薄膜在外场下的临界电流密度", requestID: "api-request" }

test("materials API accepts a short trimmed goal and rejects blank goals without creating projects", async () => {
  const api = app()
  for (const goal of ["", " \n\t", "　"]) {
    const response = await api.request("/materials/projects", request({ goal, requestID: "blank" }))
    expect(response.status).toBe(400)
  }
  expect(await (await api.request("/materials/projects")).json()).toEqual([])
  const response = await api.request("/materials/projects", request({ goal: " 提高超导性能\n", requestID: "short" }))
  expect(response.status).toBe(200)
  const created = (await response.json()) as MaterialProject
  expect(created.goal).toBe("提高超导性能")
  expect(created.target).toBe("auto")
  expect(created.status).toBe("queued")
})

test("materials API creates, persists async progress, handles conflicts and exports full provenance", async () => {
  const api = app()
  const create = await api.request("/materials/projects", request(input))
  expect(create.status).toBe(200)
  const project = (await create.json()) as MaterialProject
  expect(project.status).toBe("queued")
  expect(project.workspaceID).toBe("default")
  await Bun.sleep(50)
  const get = await api.request(`/materials/projects/${project.id}`)
  const current = (await get.json()) as MaterialProject
  expect(current.status).toBe("needs_input")
  expect(current.artifacts).toHaveLength(1)
  const conflict = await api.request(
    `/materials/projects/${project.id}/actions`,
    request({ action: "answer", answers: "77 K", revision: project.revision }),
  )
  expect(conflict.status).toBe(409)
  expect((await conflict.json()).error).toContain("课题已更新")
  const exported = await api.request(`/materials/projects/${project.id}/export`)
  expect(exported.headers.get("Content-Disposition")).toContain(`${project.id}.json`)
  expect(await exported.json()).toEqual(current)
  const list = await api.request("/materials/projects")
  expect((await list.json()).map((item: MaterialProject) => item.id)).toEqual([project.id])
})

test("materials API rejects paths, arbitrary client ownership, malformed JSON and oversized bodies", async () => {
  const api = app()
  const invalid = await api.request(
    "/materials/projects",
    request({ ...input, directory: "/tmp/arbitrary", workspaceID: "other" }),
  )
  expect(invalid.status).toBe(400)
  expect((await invalid.json()).error).toBeString()
  const unknown = await api.request(`/materials/projects/mat_${"0".repeat(32)}`)
  expect(unknown.status).toBe(404)
  expect((await unknown.json()).error).toContain("不存在")
  const traversal = await api.request("/materials/projects/%2e%2e%2fprivate")
  expect(traversal.status).toBe(400)
  const malformed = await api.request("/materials/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  })
  expect(malformed.status).toBe(400)
  expect((await malformed.json()).error).toBeString()
  const large = await api.request("/materials/projects", request({ ...input, goal: "x".repeat(3 * 1024 * 1024) }))
  expect(large.status).toBe(413)
  expect((await large.json()).error).toContain("3 MB")
})

test("materials API requires protocol approval before accepting data", async () => {
  const api = app()
  const created = await api.request("/materials/projects", request(input))
  const project = (await created.json()) as MaterialProject
  await Bun.sleep(50)
  const current = (await (await api.request(`/materials/projects/${project.id}`)).json()) as MaterialProject
  const data = await api.request(
    `/materials/projects/${project.id}/batches`,
    request({
      name: "Batch",
      protocolID: "unapproved",
      revision: current.revision,
      measurements: [{ sampleID: "s1", groupID: "g1", property: "Jc", value: 1, unit: "MA/cm2" }],
    }),
  )
  expect(data.status).toBe(409)
  expect((await data.json()).error).toContain("确认实验方案")
})

test("paper uploads retain the original alongside evidence and reject malformed upload requests", async () => {
  const api = app()
  const created = (await (await api.request("/materials/projects", request(input))).json()) as MaterialProject
  await Bun.sleep(50)
  const form = new FormData()
  form.append("file", new File(["%PDF-1.4\noriginal paper bytes\n%%EOF"], "paper.pdf", { type: "application/pdf" }))
  form.append(
    "source",
    JSON.stringify({ title: "Uploaded paper", kind: "fulltext", text: "Real text extracted from an uploaded paper." }),
  )
  const response = await api.request(`/materials/projects/${created.id}/sources/upload`, { method: "POST", body: form })
  expect(response.status).toBe(200)
  const saved = (await response.json()) as MaterialProject
  expect(saved.sources).toHaveLength(1)
  expect(saved.sources[0].origin).toBe("upload")
  expect(saved.sources[0].id).toMatch(/^src_[a-f0-9]{32}$/)
  expect(JSON.stringify(saved)).not.toContain("original paper bytes")
  const missing = new FormData()
  missing.append("source", "{}")
  expect(
    (await api.request(`/materials/projects/${created.id}/sources/upload`, { method: "POST", body: missing })).status,
  ).toBe(400)
  expect((await api.request(`/materials/projects/${created.id}/sources/upload`, request({}))).status).toBe(400)
  const invalid = new FormData()
  invalid.append("file", new File(["not a PDF"], "fake.pdf"))
  invalid.append("source", form.get("source")!)
  const bad = await api.request(`/materials/projects/${created.id}/sources/upload`, { method: "POST", body: invalid })
  expect([400, 422]).toContain(bad.status)
  const current = (await (await api.request(`/materials/projects/${created.id}`)).json()) as MaterialProject
  expect(current.sources).toHaveLength(1)
})

test("library routes keep legacy unbound tasks readable without changing research or accepting paths", async () => {
  const api = app()
  const created = (await (await api.request("/materials/projects", request(input))).json()) as MaterialProject
  await Bun.sleep(50)
  const before = await (await api.request(`/materials/projects/${created.id}`)).json()
  const read = await api.request(`/materials/projects/${created.id}/library`)
  expect(read.status).toBe(200)
  expect(read.headers.get("Cache-Control")).toBe("no-store")
  expect((await read.json()).status).toBe("unbound")
  const sync = await api.request(`/materials/projects/${created.id}/library`, request({}))
  expect(sync.status).toBe(200)
  expect((await sync.json()).status).toBe("unbound")
  const forged = await api.request(
    `/materials/projects/${created.id}/library`,
    request({ directory: "/tmp/elsewhere" }),
  )
  expect(forged.status).toBe(400)
  expect(await (await api.request(`/materials/projects/${created.id}`)).json()).toEqual(before)
})

test("activity API returns small durable progress, current revision, and no cached or model content", async () => {
  const api = app()
  const created = (await (await api.request("/materials/projects", request(input))).json()) as MaterialProject
  await Bun.sleep(50)
  const original = (await (await api.request(`/materials/projects/${created.id}`)).json()) as MaterialProject
  const uploaded = await api.request(
    `/materials/projects/${created.id}/sources`,
    request({
      title: "Large evidence",
      kind: "fulltext",
      text: "sensitive full paper body ".repeat(5_000),
    }),
  )
  expect(uploaded.status).toBe(200)
  const project = (await uploaded.json()) as MaterialProject
  const response = await api.request(`/materials/projects/${project.id}/activity`)
  expect(response.status).toBe(200)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  const body = await response.text()
  const activity = MaterialActivitySnapshot.parse(JSON.parse(body))
  expect(activity.projectID).toBe(project.id)
  expect(activity.revision).toBe(project.revision)
  expect(activity.revision).toBeGreaterThan(original.revision)
  expect(activity.status).toBe(project.status)
  expect(activity.current?.phase).toBe("completed")
  expect(activity.events.map((event) => event.phase)).toEqual(["preparing", "validating", "saving", "completed"])
  expect(activity.serverTime).toBeGreaterThanOrEqual(activity.current!.updatedAt)
  expect(body.length).toBeLessThan(5_000)
  expect(body).not.toContain("sensitive full paper body")
  expect(body).not.toContain("artifacts")
  const missing = await api.request(`/materials/projects/mat_${"0".repeat(32)}/activity`)
  expect(missing.status).toBe(404)
  const invalid = await api.request("/materials/projects/%2e%2e%2fprivate/activity")
  expect(invalid.status).toBe(400)
})

test("the first HTTP request releases its scope while the durable runtime blocks data relocation", async () => {
  const [{ Global }, { DataRootBarrier }] = await Promise.all([
    import("../../src/global"),
    import("../../src/global/data-root-barrier"),
  ])
  const api = new Hono()
    .use("*", async (_c, next) => {
      await DataRootBarrier.during(Global.Path.data, next)
    })
    .route("/materials", createMaterialsRoutes())
  const response = await Promise.race([
    api.request("/materials/projects"),
    Bun.sleep(2_000).then(() => {
      throw new Error("First materials request failed to release its request scope")
    }),
  ])
  try {
    expect(response.status).toBe(200)
    const { DataRelocation } = await import("../../src/global/data-relocation")
    await expect(
      DataRelocation.relocate(path.join(os.tmpdir(), `materials-relocation-${crypto.randomUUID()}`)),
    ).rejects.toThrow("材料科研运行时")
    await expect(DataRootBarrier.exclusive(50)).rejects.toThrow("did not quiesce")
  } finally {
    await disposeMaterialsService()
  }
  await using exclusive = await DataRootBarrier.exclusive(500)
  expect(exclusive).toBeDefined()
})

test("mounted materials routes retain OpenAPI metadata in the complete server", async () => {
  const { Server } = await import("../../src/server/server")
  const document = await Server.openapi()
  for (const route of [
    "/materials/projects",
    "/materials/projects/{id}",
    "/materials/projects/{id}/activity",
    "/materials/projects/{id}/library",
    "/materials/projects/{id}/actions",
    "/materials/projects/{id}/sources",
    "/materials/projects/{id}/sources/upload",
    "/materials/projects/{id}/batches",
    "/materials/projects/{id}/export",
  ]) {
    expect(document.paths?.[route]).toBeDefined()
  }
  expect(document.paths?.["/materials/projects"]?.post?.operationId).toBe("materials.create")
  expect(document.paths?.["/materials/projects/{id}/activity"]?.get?.operationId).toBe("materials.activity")
})

test("a first research request admitted before relocation can publish its durable marker without deadlock", async () => {
  const [{ Global }, { DataRootBarrier }] = await Promise.all([
    import("../../src/global"),
    import("../../src/global/data-root-barrier"),
  ])
  await disposeMaterialsService()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const api = new Hono()
    .use("*", async (_c, next) => {
      await DataRootBarrier.during(Global.Path.data, next)
    })
    .use("*", async (_c, next) => {
      entered.resolve()
      await release.promise
      return next()
    })
    .route("/materials", createMaterialsRoutes())
  const pending = api.request("/materials/projects")
  await entered.promise
  const relocation = DataRootBarrier.exclusive(2_000)
  void relocation.catch(() => undefined)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await Bun.file(path.join(Global.Path.config, "data-root-switch.intent")).exists()) break
    await Bun.sleep(5)
  }
  release.resolve()
  try {
    const response = await Promise.race([
      pending,
      Bun.sleep(500).then(() => {
        throw new Error("Material initialization deadlocked against relocation")
      }),
    ])
    expect(response.status).toBe(200)
  } finally {
    await disposeMaterialsService()
    await (await relocation)[Symbol.asyncDispose]()
  }
})
