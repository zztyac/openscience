import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MaterialSkillSnapshot } from "@synsci/util/materials"
import { createMaterialsRoutes } from "../../src/server/routes/materials"
import { createMaterialSkillSettings } from "../../src/materials/skill-config"
import { MaterialsService } from "../../src/materials/workflow"

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "materials-skills-api-"))
  let calls = 0
  const service = new MaterialsService({
    directory,
    executor: async () => {
      calls++
      throw new Error("Settings must not start research")
    },
  })
  const settings = createMaterialSkillSettings({ directory, availability: () => ({ available: true }) })
  disposals.push(async () => {
    service.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { api: new Hono().route("/materials", createMaterialsRoutes(service, settings)), calls: () => calls }
}
const request = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

test("stage skill HTTP settings persist without creating research and reject stale revisions", async () => {
  const { api, calls } = await fixture()
  const response = await api.request("/materials/skills")
  expect(response.status).toBe(200)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  const current = MaterialSkillSnapshot.parse(await response.json())
  expect(current.catalog).toHaveLength(6)
  const input = { revision: current.revision, stages: { ...current.stages, ideas: ["semantic-scholar"] } }
  const update = await api.request("/materials/skills", request(input))
  expect(update.status).toBe(200)
  const saved = MaterialSkillSnapshot.parse(await update.json())
  expect(saved.stages.ideas).toEqual(["semantic-scholar"])
  expect(saved.revision).toBe(1)
  expect((await api.request("/materials/skills", request(input))).status).toBe(409)
  expect(MaterialSkillSnapshot.parse(await (await api.request("/materials/skills")).json())).toEqual(saved)
  expect(await (await api.request("/materials/projects")).json()).toEqual([])
  expect(calls()).toBe(0)
})

test("stage skill HTTP settings reject invalid names and malformed JSON", async () => {
  const { api } = await fixture()
  const current = MaterialSkillSnapshot.parse(await (await api.request("/materials/skills")).json())
  for (const input of [
    { revision: 0, stages: { ...current.stages, literature: ["../secret"] } },
    { revision: 0, stages: { ...current.stages, literature: ["shell"] } },
    { revision: 0, stages: current.stages, api_key: "secret" },
    { revision: -1, stages: current.stages },
  ])
    expect((await api.request("/materials/skills", request(input))).status).toBe(400)
  expect(
    (
      await api.request("/materials/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
  ).toBe(400)
  expect(MaterialSkillSnapshot.parse(await (await api.request("/materials/skills")).json()).revision).toBe(0)
})
