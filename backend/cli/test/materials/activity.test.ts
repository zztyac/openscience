import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { MaterialReporter } from "@synsci/util/materials"
import { materialActivity } from "../../src/materials/activity"
import { MaterialsStore } from "../../src/materials/store"
import { MaterialsService, type StageResult } from "../../src/materials/workflow"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function directory() {
  const value = mkdtempSync(path.join(os.tmpdir(), "materials-activity-"))
  cleanups.push(() => rmSync(value, { force: true, recursive: true }))
  return value
}
function running() {
  const store = new MaterialsStore(directory())
  cleanups.push(() => store.close())
  store.acquire()
  const created = store.create({ goal: "提高 REBCO 性能", requestID: "activity" })
  const project = store.update(created.id, created.revision, (next) => {
    next.status = "running"
  })
  const token = store.beginActivity(project.id, "strategies")!
  return { store, project, token }
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("Workflow did not reach expected state")
}

test("activity survives reopening, is bounded, and does not conflict with business revisions", () => {
  const { store, project, token } = running()
  store.reportActivity(project.id, token, { phase: "preparing", role: "builder", model: "fixture/model" })
  store.reportActivity(project.id, token, { phase: "waiting" })
  for (let i = 0; i < 250; i++) {
    store.reportActivity(project.id, token, {
      phase: "retrieving",
      role: "fulltext-retrieval",
      item: `paper-${i}`,
      completed: i,
      total: 250,
    })
  }
  const activity = store.activity(project.id)
  expect(activity.revision).toBe(project.revision)
  expect(activity.events).toHaveLength(200)
  expect(activity.events.at(-1)?.item).toBe("paper-249")
  expect(store.get(project.id).events).toEqual(project.events)
  const second = new MaterialsStore(store.directory)
  cleanups.push(() => second.close())
  expect(second.activity(project.id).events).toEqual(activity.events)
  expect(second.activity(project.id).current).toEqual(activity.current)
  expect(
    second.update(project.id, project.revision, (next) => {
      next.answers = "77 K"
    }).answers,
  ).toBe("77 K")
})

test("phase timing follows real operations and model activity never comes from waiting updates", async () => {
  const { store, project, token } = running()
  store.reportActivity(project.id, token, {
    phase: "preparing",
    role: "builder",
    model: "fixture/model",
    step: 1,
    steps: 2,
  })
  const initial = store.activity(project.id).current!
  await Bun.sleep(3)
  store.reportActivity(project.id, token, { phase: "waiting" })
  expect(store.activity(project.id).current?.startedAt).toBe(initial.startedAt)
  expect(store.activity(project.id).current?.lastModelActivityAt).toBeUndefined()
  store.reportActivity(project.id, token, { phase: "reasoning", outputChars: 0 })
  const observed = store.activity(project.id).current!.lastModelActivityAt
  expect(observed).toBeNumber()
  store.reportActivity(project.id, token, { phase: "generating", outputChars: 100 })
  store.reportActivity(project.id, token, { phase: "validating" })
  expect(store.activity(project.id).current).toMatchObject({
    startedAt: initial.startedAt,
    outputChars: 100,
    model: "fixture/model",
  })
  await Bun.sleep(3)
  store.reportActivity(project.id, token, {
    phase: "searching",
    role: "literature-search",
    completed: 1,
    total: 4,
    item: "REBCO",
  })
  const changed = store.activity(project.id).current!
  expect(changed.startedAt).toBeGreaterThan(initial.startedAt)
  expect(changed.lastModelActivityAt).toBeUndefined()
  expect(changed.outputChars).toBeUndefined()
  expect(changed.model).toBeUndefined()
  expect(changed.step).toBeUndefined()
  store.reportActivity(project.id, token, { phase: "repairing", role: "literature-search" })
  expect(store.activity(project.id).current?.completed).toBeUndefined()
  expect(store.activity(project.id).current?.item).toBeUndefined()
})

test("stream chunks are coalesced, final counters are flushed, and no raw model output enters logs", async () => {
  const { store, project } = running()
  const controller = new AbortController()
  const tracker = materialActivity(store, project.id, "strategies", controller.signal)
  tracker.report({ phase: "preparing", role: "builder" })
  tracker.report({ phase: "generating", outputChars: 1 })
  const count = store.activity(project.id).events.length
  for (let outputChars = 2; outputChars <= 100; outputChars++) tracker.report({ phase: "generating", outputChars })
  expect(store.activity(project.id).current?.outputChars).toBe(1)
  expect(store.activity(project.id).events).toHaveLength(count)
  await Bun.sleep(1_050)
  expect(store.activity(project.id).current?.outputChars).toBe(100)
  tracker.report({ phase: "generating", outputChars: 120 })
  tracker.report({ phase: "saving" })
  tracker.finish("completed")
  tracker.report({ phase: "generating", outputChars: 200 })
  expect(store.activity(project.id).current).toMatchObject({ phase: "completed", outputChars: 120 })
  expect(store.activity(project.id).events).toHaveLength(count + 2)
  expect(store.get(project.id).revision).toBe(project.revision)
})

test("model resolution enriches preparation and repair without restarting the operation or duplicating logs", async () => {
  const { store, project } = running()
  const tracker = materialActivity(store, project.id, "strategies", new AbortController().signal)
  for (const phase of ["preparing", "repairing"] as const) {
    const role = phase === "preparing" ? "strategy-builder" : "strategy-builder:repair"
    tracker.report({ phase, role, step: 1, steps: 2, outputChars: 0 })
    const before = store.activity(project.id)
    await Bun.sleep(3)
    tracker.report({ phase, role, model: "fixture/model", step: 1, steps: 2 })
    const after = store.activity(project.id)
    expect(after.current).toMatchObject({
      phase,
      role,
      model: "fixture/model",
      step: 1,
      steps: 2,
      outputChars: 0,
      startedAt: before.current!.startedAt,
    })
    expect(after.events).toEqual(before.events)
    tracker.report({ phase: "waiting", role })
    tracker.report({ phase: "generating", role, outputChars: 20 })
    tracker.report({ phase: "validating", role })
    await Bun.sleep(3)
    tracker.report({ phase, role, step: 1, steps: 2, outputChars: 0 })
    const restarted = store.activity(project.id).current!
    expect(restarted.startedAt).toBeGreaterThan(before.current!.startedAt)
    expect(restarted.outputChars).toBe(0)
    expect(restarted.lastModelActivityAt).toBeUndefined()
  }
  tracker.finish("completed")
})

test("cancelled and expired runs cannot overwrite a retry or revive terminal activity", () => {
  const { store, project, token } = running()
  store.reportActivity(project.id, token, { phase: "generating", outputChars: 5 })
  store.update(project.id, project.revision, (next) => {
    next.status = "cancelled"
  })
  store.reportActivity(project.id, token, { phase: "generating", outputChars: 50 })
  expect(store.activity(project.id).current?.phase).toBe("cancelled")
  store.update(project.id, undefined, (next) => {
    next.status = "running"
  })
  const retry = store.beginActivity(project.id, "strategies")!
  store.reportActivity(project.id, retry, { phase: "waiting", role: "retry" })
  store.reportActivity(project.id, token, { phase: "generating", role: "old", outputChars: 100 })
  store.finishActivity(project.id, token, "failed")
  expect(store.activity(project.id).current).toMatchObject({ phase: "waiting", role: "retry" })
  store.finishActivity(project.id, retry, "completed")
  store.reportActivity(project.id, retry, { phase: "reasoning" })
  expect(store.activity(project.id).current?.phase).toBe("completed")
})

test("activity rejects raw fields and abort discards scheduled chunks after a terminal update", async () => {
  const { store, project, token } = running()
  expect(() =>
    store.reportActivity(project.id, token, {
      phase: "generating",
      outputChars: 1,
      text: "private model output",
    } as Parameters<MaterialsStore["reportActivity"]>[2]),
  ).toThrow()
  expect(JSON.stringify(store.activity(project.id))).not.toContain("private model output")
  const controller = new AbortController()
  const tracker = materialActivity(store, project.id, "strategies", controller.signal)
  tracker.report({ phase: "generating", outputChars: 1 })
  tracker.report({ phase: "generating", outputChars: 2 })
  store.update(project.id, project.revision, (next) => {
    next.status = "cancelled"
  })
  controller.abort()
  const terminal = store.activity(project.id)
  await Bun.sleep(1_050)
  expect(store.activity(project.id).current).toEqual(terminal.current)
  expect(store.activity(project.id).events).toEqual(terminal.events)
})

test("workflow failure preserves the last observed generated character count without waiting for a throttle tick", async () => {
  const service = new MaterialsService({
    directory: directory(),
    pollInterval: 10,
    executor: async (_project, _stage, _signal, report) => {
      report?.({ phase: "generating", role: "intake", outputChars: 1 })
      report?.({ phase: "generating", role: "intake", outputChars: 123 })
      throw new Error("private upstream response")
    },
  })
  cleanups.push(() => service.close())
  const project = service.create({ goal: "提高 REBCO 性能", requestID: "failure-count" })
  await until(() => service.get(project.id).status === "failed")
  expect(service.activity(project.id).current).toMatchObject({ phase: "failed", outputChars: 123 })
  expect(JSON.stringify(service.activity(project.id))).not.toContain("private upstream response")
})

test("legacy projects migrate and lightweight activity reads do not decode project snapshots", () => {
  const dir = directory()
  const first = new MaterialsStore(dir)
  const project = first.create({ goal: "提高 REBCO 性能", requestID: "legacy" })
  first.close()
  const raw = new Database(path.join(dir, "materials.sqlite"))
  raw.exec("ALTER TABLE projects DROP COLUMN status")
  raw.close()
  const store = new MaterialsStore(dir)
  cleanups.push(() => store.close())
  expect(store.activity(project.id)).toMatchObject({ status: "queued", revision: 0, events: [] })
  expect(store.activity(project.id).current).toBeUndefined()
  store.db.query("UPDATE projects SET json=? WHERE id=?").run("not a project snapshot", project.id)
  expect(store.activity(project.id)).toMatchObject({ status: "queued", revision: 0, events: [] })
  expect(() => store.activity("../private")).toThrow("不存在")
})

test("workflow exposes durable completion and failure, cancellation, retry, and shutdown activity", async () => {
  const reports: MaterialReporter[] = []
  const completions: Array<(result: StageResult) => void> = []
  const service = new MaterialsService({
    directory: directory(),
    pollInterval: 10,
    executor: async (_project, _stage, _signal, report) => {
      reports.push(report!)
      report?.({ phase: "waiting", role: "intake", step: 1, steps: 1 })
      return new Promise<StageResult>((resolve) => completions.push(resolve))
    },
  })
  cleanups.push(() => service.close())
  const project = service.create({ goal: "提高 REBCO 性能", requestID: "workflow" })
  await until(() => reports.length === 1)
  service.decide(project.id, { action: "cancel", revision: service.get(project.id).revision })
  expect(service.activity(project.id).current?.phase).toBe("cancelled")
  service.decide(project.id, { action: "resume", revision: service.get(project.id).revision })
  reports[0]({ phase: "generating", outputChars: 200 })
  completions[0]({ title: "old", markdown: "old", data: {} })
  await until(() => reports.length === 2)
  reports[0]({ phase: "reasoning" })
  expect(service.activity(project.id).current?.phase).toBe("waiting")
  expect(service.activity(project.id).current?.outputChars).toBeUndefined()
  completions[1]({
    title: "intake",
    markdown: "goal",
    data: {
      title: "REBCO",
      materialSystem: "REBCO",
      objective: "Jc",
      constraints: [],
      searchQueries: ["REBCO"],
      questions: ["温度？"],
      target: "ideas",
    },
  })
  await until(() => service.get(project.id).status === "needs_input")
  expect(service.activity(project.id).current?.phase).toBe("completed")
  expect(service.activity(project.id).events.some((event) => event.phase === "saving")).toBe(true)
  service.decide(project.id, { action: "answer", answers: "77 K", revision: service.get(project.id).revision })
  await until(() => reports.length === 3)
  completions[2]({ title: "invalid", markdown: "invalid", data: {} })
  await until(() => service.get(project.id).status === "failed")
  expect(service.activity(project.id).current?.phase).toBe("failed")
  service.decide(project.id, { action: "resume", revision: service.get(project.id).revision })
  await until(() => reports.length === 4)
  service.close()
  reports[3]({ phase: "generating", outputChars: 400 })
  completions[3]({ title: "old", markdown: "old", data: {} })
  const reopened = new MaterialsStore(service.store.directory)
  cleanups.push(() => reopened.close())
  expect(reopened.activity(project.id)).toMatchObject({ status: "interrupted", current: { phase: "interrupted" } })
})
