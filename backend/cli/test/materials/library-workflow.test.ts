import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { MaterialLibrarySnapshot, MaterialProject } from "@synsci/util/materials"
import { MaterialsService } from "../../src/materials/workflow"

const resources: MaterialsService[] = []
afterEach(async () => {
  for (const service of resources.splice(0)) {
    service.close()
    await service.flushLibrary()
    rmSync(service.store.directory, { recursive: true, force: true })
  }
})
const snapshot = (project: MaterialProject): MaterialLibrarySnapshot => ({
  materialsProjectID: project.id,
  status: "synced",
  revision: project.revision,
  files: [],
  warnings: [],
})
function create(sync: (project: MaterialProject) => Promise<MaterialLibrarySnapshot>) {
  let executions = 0
  const service = new MaterialsService({
    directory: mkdtempSync(path.join(os.tmpdir(), "materials-library-workflow-")),
    pollInterval: 10,
    library: { read: async (project) => snapshot(project), sync },
    executor: async () => {
      executions++
      return {
        title: "目标澄清",
        markdown: "# 目标澄清",
        data: {
          title: "REBCO",
          materialSystem: "REBCO",
          objective: "Improve Jc",
          constraints: [],
          searchQueries: ["REBCO"],
          questions: ["目标磁场？"],
          target: "protocol",
        },
      }
    },
  })
  resources.push(service)
  return { service, executions: () => executions }
}
async function ready(service: MaterialsService, id: string) {
  for (let i = 0; i < 100; i++) {
    if (service.get(id).status === "needs_input") return
    await Bun.sleep(10)
  }
  throw new Error("Workflow did not reach its human question")
}

test("stage saves and source uploads sync automatically; explicit resync never reruns research", async () => {
  const saved: MaterialProject[] = []
  const { service, executions } = create(async (project) => {
    saved.push(project)
    return snapshot(project)
  })
  const project = service.create({ goal: "Improve REBCO", requestID: "files" }, { sessionID: "ses_original" })
  await ready(service, project.id)
  await service.flushLibrary()
  expect(saved.at(-1)?.artifacts).toHaveLength(1)
  const before = service.get(project.id)
  expect(await service.syncLibrary(project.id)).toMatchObject({ status: "synced", revision: before.revision })
  expect(service.get(project.id)).toEqual(before)
  expect(executions()).toBe(1)
  service.source(project.id, { title: "Paper", kind: "abstract", text: "A verifiable abstract about REBCO films." })
  await service.flushLibrary()
  expect(saved.at(-1)?.sources).toHaveLength(1)
  expect(saved.at(-1)?.revision).toBe(service.get(project.id).revision)
})

test("projection errors preserve scientific artifacts and a later manual sync clears the error", async () => {
  let fail = true
  const { service, executions } = create(async (project) => {
    if (fail) throw new Error("private storage error containing secret token")
    return snapshot(project)
  })
  const project = service.create({ goal: "Improve REBCO", requestID: "failure" })
  await ready(service, project.id)
  await service.flushLibrary()
  const current = service.get(project.id)
  expect(current.artifacts).toHaveLength(1)
  expect(current.error).toBeUndefined()
  expect(await service.library(project.id)).toMatchObject({ status: "error" })
  expect(JSON.stringify(await service.library(project.id))).not.toContain("secret token")
  fail = false
  expect(await service.syncLibrary(project.id)).toMatchObject({ status: "synced" })
  expect(await service.library(project.id)).toMatchObject({ status: "synced" })
  expect(service.get(project.id)).toEqual(current)
  expect(executions()).toBe(1)
})

test("concurrent updates coalesce behind one sync and retain the newest revision", async () => {
  const releases: Array<() => void> = []
  const revisions: number[] = []
  let active = 0
  let maximum = 0
  const { service } = create(async (project) => {
    active++
    maximum = Math.max(maximum, active)
    revisions.push(project.revision)
    if (revisions.length === 1) await new Promise<void>((resolve) => releases.push(resolve))
    active--
    return snapshot(project)
  })
  const project = service.create({ goal: "Improve REBCO", requestID: "coalesced" })
  await ready(service, project.id)
  for (let i = 0; i < 3; i++)
    service.source(project.id, { title: `Paper ${i}`, kind: "note", text: "A sufficiently long research note." })
  expect((await service.library(project.id)).status).toBe("syncing")
  const manual = service.syncLibrary(project.id)
  releases[0]()
  await manual
  await service.flushLibrary()
  expect(maximum).toBe(1)
  expect(revisions).toHaveLength(2)
  expect(revisions.at(-1)).toBe(service.get(project.id).revision)
})

test("an update arriving as the last sync resolves cannot be stranded behind a finished worker", async () => {
  let inject = false
  let latest = -1
  const { service } = create(async (project) => {
    latest = project.revision
    if (inject) {
      inject = false
      queueMicrotask(() =>
        queueMicrotask(() => {
          service.source(project.id, {
            title: "Late source",
            kind: "note",
            text: "A newly saved research note with enough text.",
          })
        }),
      )
    }
    return snapshot(project)
  })
  const project = service.create({ goal: "Improve REBCO", requestID: "last-microtask" })
  await ready(service, project.id)
  await service.flushLibrary()
  inject = true
  await service.syncLibrary(project.id)
  await service.flushLibrary()
  expect(service.get(project.id).sources).toHaveLength(1)
  expect(latest).toBe(service.get(project.id).revision)
})
