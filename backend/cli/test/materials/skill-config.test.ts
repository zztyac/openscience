import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MaterialSkillConfig, MaterialSkillSnapshot, MaterialSourceInput } from "@synsci/util/materials"
import { createMaterialSkillSettings, defaultMaterialSkills } from "../../src/materials/skill-config"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "materials-skills-"))
  directories.push(directory)
  return directory
}
const available = () => ({ available: true })

test("reading absent stage configuration returns detached defaults without creating files", async () => {
  const directory = await fixture()
  const settings = createMaterialSkillSettings({ directory, availability: available })
  const first = await settings.read()
  expect(first).toEqual(defaultMaterialSkills())
  first.stages.literature.splice(0)
  expect((await settings.read()).stages.literature).toEqual(["arxiv", "openalex", "semantic-scholar", "research-lit"])
  expect(await fs.readdir(directory)).toEqual([])
})

test("all six stages persist, deduplicate skill names and retain unavailable selections", async () => {
  const directory = await fixture()
  const settings = createMaterialSkillSettings({
    directory,
    availability: (name) => (name === "exa-search" ? { available: false, reason: "缺少 Exa API key" } : available()),
  })
  const input = defaultMaterialSkills()
  for (const stage of Object.keys(input.stages) as Array<keyof typeof input.stages>)
    input.stages[stage] = ["arxiv", "exa-search", "arxiv"]
  const saved = await settings.save(input)
  expect(saved.revision).toBe(1)
  for (const stage of Object.values(saved.stages)) expect(stage).toEqual(["arxiv", "exa-search"])
  expect(saved.catalog.find((item) => item.name === "exa-search")).toMatchObject({
    available: false,
    reason: "缺少 Exa API key",
  })
  const fresh = createMaterialSkillSettings({ directory, availability: available })
  expect(await fresh.read()).toEqual({ revision: 1, stages: saved.stages })
  expect((await fresh.get()).catalog.every((item) => item.available)).toBe(true)
  const file = path.join(directory, "skills.json")
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  expect(Object.keys(await Bun.file(file).json()).sort()).toEqual(["revision", "stages"])
  expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([])
})

test("concurrent stale writers cannot silently overwrite another settings instance", async () => {
  const directory = await fixture()
  const left = createMaterialSkillSettings({ directory, availability: available })
  const right = createMaterialSkillSettings({ directory, availability: available })
  const first = defaultMaterialSkills()
  const second = defaultMaterialSkills()
  first.stages.ideas = ["arxiv"]
  second.stages.ideas = ["openalex"]
  const results = await Promise.allSettled([left.save(first), right.save(second)])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  const failed = results.find((result) => result.status === "rejected")
  expect(failed?.status === "rejected" && failed.reason.status).toBe(409)
  const saved = await left.read()
  expect(saved.revision).toBe(1)
  expect([["arxiv"], ["openalex"]]).toContainEqual(saved.stages.ideas)
  const updated = await right.save({ ...saved, stages: { ...saved.stages, protocol: ["research-lit"] } })
  expect(updated.revision).toBe(2)
  expect(updated.stages.ideas).toEqual(saved.stages.ideas)
})

test("corrupt or invalid configuration fails without replacing the original", async () => {
  const directory = await fixture()
  const settings = createMaterialSkillSettings({ directory, availability: available })
  const file = path.join(directory, "skills.json")
  for (const data of [
    "{broken",
    "{}",
    "null",
    JSON.stringify({ ...defaultMaterialSkills(), stages: { literature: ["arxiv"] } }),
  ]) {
    await Bun.write(file, data)
    await expect(settings.read()).rejects.toMatchObject({ status: 503 })
    await expect(settings.save(defaultMaterialSkills())).rejects.toMatchObject({ status: 503 })
    expect(await Bun.file(file).text()).toBe(data)
  }
})

test("stage bindings reject unknown skills, missing stages and unrecognized settings", async () => {
  const input = defaultMaterialSkills()
  expect(MaterialSkillConfig.safeParse({ ...input, apiKey: "must-not-be-stored" }).success).toBe(false)
  expect(MaterialSkillConfig.safeParse({ ...input, stages: { ...input.stages, ideas: ["shell"] } }).success).toBe(false)
  expect(
    MaterialSkillConfig.safeParse({ ...input, stages: { ...input.stages, ideas: Array(7).fill("arxiv") } }).success,
  ).toBe(false)
  expect(MaterialSkillConfig.safeParse({ revision: 0, stages: { literature: [] } }).success).toBe(false)
  expect(
    MaterialSkillSnapshot.safeParse({ ...input, catalog: [{ name: "arxiv", description: "x", available: true }] })
      .success,
  ).toBe(true)
})

test("manual paper input cannot supply a connector-authored full-text URL", () => {
  expect(
    MaterialSourceInput.safeParse({
      title: "User paper",
      text: "An original abstract with sufficient length.",
      kind: "abstract",
      fulltextURL: "https://example.org/direct.pdf",
    }).success,
  ).toBe(false)
})
