import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import type { MaterialActivitySnapshot, MaterialProject } from "@synsci/util/materials"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import { materialText } from "./i18n"
import type { MaterialRequest } from "./session-card"

const server = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [card, activity, api, web, store] = await Promise.all([
  server.ssrLoadModule("/src/materials/session-card.tsx") as Promise<typeof import("./session-card")>,
  server.ssrLoadModule("/src/materials/activity.tsx") as Promise<typeof import("./activity")>,
  server.ssrLoadModule("/src/components/settings/api.ts") as Promise<typeof import("@/components/settings/api")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  server.ssrLoadModule("solid-js/store") as Promise<typeof import("solid-js/store")>,
])
function cardFixture(props: Parameters<typeof card.MaterialSessionCard>[0]) {
  return card.MaterialSessionCard({
    ...props,
    get projectID() {
      return props.projectID
    },
    request: ((path: string, init?: RequestInit) =>
      path.endsWith("/library")
        ? Promise.resolve({ materialsProjectID: props.projectID, status: "unbound", files: [], warnings: [] })
        : props.request(path, init)) as MaterialRequest,
  })
}
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
const flush = async () => {
  await Bun.sleep(0)
  await Bun.sleep(0)
}
const t = (key: Parameters<typeof materialText>[1]) => materialText("zh", key)
function mount(view: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(view, host)
  cleanups.push(dispose)
  return { host, dispose }
}
function project(overrides: Partial<MaterialProject> = {}): MaterialProject {
  return {
    id: "mat_activity_fixture",
    workspaceID: "default",
    title: "REBCO fixture",
    goal: "Improve critical current with verifiable evidence",
    domain: "rebco",
    target: "ideas",
    status: "running",
    revision: 1,
    createdAt: 1,
    updatedAt: Date.now(),
    answers: "",
    questions: [],
    stages: [{ key: "strategies", status: "running", startedAt: Date.now() - 5000 }],
    sources: [],
    artifacts: [],
    batches: [],
    events: [],
    selectedIdeaIDs: [],
    ...overrides,
  }
}
function snapshot(value: MaterialProject, overrides: Partial<MaterialActivitySnapshot> = {}): MaterialActivitySnapshot {
  return {
    projectID: value.id,
    revision: value.revision,
    status: value.status,
    serverTime: Date.now(),
    current: {
      stage: "strategies",
      phase: "waiting",
      role: "strategy-builder",
      model: "fixture/model",
      step: 1,
      steps: 2,
      startedAt: Date.now() - 5000,
      updatedAt: Date.now(),
      outputChars: 0,
    },
    events: [],
    ...overrides,
  }
}

// Advance UI clocks and polling timers without waiting seconds between assertions.
function clock() {
  const original = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  const interval = globalThis.setInterval
  const clearInterval = globalThis.clearInterval
  const time = { now: 100_000 }
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; repeat?: number; run: () => void }>()
  const schedule = (handler: TimerHandler, delay: number, repeat: boolean, args: unknown[]) => {
    if (typeof handler !== "function") throw new Error("Expected a timer callback")
    const handle = original(() => {}, 2_147_483_647)
    timers.set(handle, { at: time.now + delay, repeat: repeat ? delay : undefined, run: () => handler(...args) })
    return handle
  }
  const timeoutMock = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (handler: TimerHandler, delay = 0, ...args: unknown[]) =>
        delay >= 1000 ? schedule(handler, delay, false, args) : original(handler, delay, ...args),
      { __promisify__: original.__promisify__ },
    ) as unknown as typeof setTimeout,
  )
  const intervalMock = spyOn(globalThis, "setInterval").mockImplementation(((
    handler: TimerHandler,
    delay = 0,
    ...args: unknown[]
  ) =>
    delay >= 1000 ? schedule(handler, delay, true, args) : interval(handler, delay, ...args)) as typeof setInterval)
  const clearMock = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    timers.delete(handle as ReturnType<typeof setTimeout>)
    clear(handle as Parameters<typeof clear>[0])
  })
  const clearIntervalMock = spyOn(globalThis, "clearInterval").mockImplementation((handle) => {
    if (timers.delete(handle as ReturnType<typeof setTimeout>)) clear(handle as Parameters<typeof clear>[0])
    else clearInterval(handle as Parameters<typeof clearInterval>[0])
  })
  const date = spyOn(Date, "now").mockImplementation(() => time.now)
  cleanups.push(() => {
    for (const handle of timers.keys()) clear(handle)
    timeoutMock.mockRestore()
    intervalMock.mockRestore()
    clearMock.mockRestore()
    clearIntervalMock.mockRestore()
    date.mockRestore()
  })
  return {
    async advance(milliseconds: number) {
      const target = time.now + milliseconds
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        time.now = next[1].at
        if (next[1].repeat) next[1].at += next[1].repeat
        else {
          timers.delete(next[0])
          clear(next[0])
        }
        next[1].run()
        await flush()
      }
      time.now = target
      await flush()
    },
  }
}

test("polls lightweight activity and fetches complete project content only after its revision changes", async () => {
  const timer = clock()
  let value = project()
  let details = snapshot(value)
  const counts = { full: 0, activity: 0 }
  const request = (async (path: string) => {
    if (path.endsWith("/activity")) {
      counts.activity++
      return { ...details, serverTime: Date.now() }
    }
    counts.full++
    return value
  }) as MaterialRequest
  const { host } = mount(() => cardFixture({ projectID: value.id, request, t, locale: "zh" }))
  await flush()
  expect(counts).toEqual({ full: 1, activity: 1 })
  expect(host.querySelector(".mat-activity-status")?.textContent).toContain("等待模型响应")
  expect(host.textContent).toContain("无法据此判断接口排队或模型内部过程")
  expect(host.querySelector('[data-field="operation"]')?.textContent).toBe("1 / 2")
  details = {
    ...details,
    current: { ...details.current!, phase: "generating", outputChars: 42, lastModelActivityAt: Date.now() },
  }
  await timer.advance(2000)
  expect(counts).toEqual({ full: 1, activity: 2 })
  expect(host.querySelector('[data-field="output"]')?.textContent).toBe("42")
  expect(host.textContent).toContain("完整输出通过结构与证据校验")
  value = { ...value, revision: 2, stages: [{ key: "ideas", status: "running", startedAt: Date.now() }] }
  details = snapshot(value, {
    current: { ...details.current!, stage: "ideas", role: "idea-expert", phase: "reasoning" },
  })
  await timer.advance(2000)
  expect(counts).toEqual({ full: 2, activity: 3 })
  expect(host.querySelector(".mat-activity-status")?.textContent).toContain("创新方案")
  expect(host.textContent).toContain("创新生成：提出可验证的研究假设")
  expect(host.textContent).toContain("此处仅显示活动状态")
})

test("updates elapsed time each second and freezes the last known operation when offline or stopped", async () => {
  const timer = clock()
  const value = project()
  const [state, setState] = store.createStore({ details: snapshot(value), connected: true })
  const { host } = mount(() =>
    activity.MaterialActivityPanel({
      project: value,
      get snapshot() {
        return state.details
      },
      get connected() {
        return state.connected
      },
      receivedAt: Date.now(),
      lastSuccessAt: Date.now(),
      legacy: false,
      locale: "zh",
      t,
    }),
  )
  const elapsed = () => host.querySelector('[data-field="elapsed"]')?.textContent
  expect(elapsed()).toBe("00:05")
  await timer.advance(2000)
  expect(elapsed()).toBe("00:07")
  setState("connected", false)
  const lastKnown = elapsed()
  await timer.advance(3000)
  expect(elapsed()).toBe(lastKnown)
  expect(host.querySelector(".mat-activity-connection")?.textContent).toBe("反馈中断")
  expect(host.textContent).toContain("服务端可能仍在执行")
  setState({
    connected: true,
    details: {
      ...state.details,
      status: "cancelled",
      current: { ...state.details.current!, phase: "cancelled", updatedAt: Date.now() },
    },
  })
  const stopped = elapsed()
  await timer.advance(5000)
  expect(elapsed()).toBe(stopped)
  expect(host.querySelector(".mat-activity-status")?.textContent).toContain("已取消")
})

test("marks a polling failure offline and restores live details after a manual refresh", async () => {
  const timer = clock()
  const value = project()
  let offline = false
  const request = (async (path: string) => {
    if (!path.endsWith("/activity")) return value
    if (offline) throw new TypeError("fixture offline")
    return snapshot(value)
  }) as MaterialRequest
  const { host } = mount(() => cardFixture({ projectID: value.id, request, t, locale: "zh" }))
  await flush()
  offline = true
  await timer.advance(2000)
  expect(host.querySelector(".mat-activity")?.getAttribute("data-connected")).toBe("false")
  expect(host.querySelector(".mat-activity-connection")?.textContent).toBe("反馈中断")
  offline = false
  host.querySelector<HTMLButtonElement>(".mat-error button")!.click()
  await flush()
  expect(host.querySelector(".mat-activity")?.getAttribute("data-connected")).toBe("true")
  expect(host.querySelector(".mat-error")).toBeNull()
})

test.each(["cancelled", "failed", "completed"] as const)(
  "queued retries hide the previous %s operation while preserving history, then show the new operation",
  async (phase) => {
    const timer = clock()
    const value = project()
    const details = snapshot(value)
    const previous = { ...details.current!, phase, updatedAt: Date.now(), outputChars: 1234 }
    const [state, setState] = store.createStore({ value, details })
    const { host } = mount(() =>
      activity.MaterialActivityPanel({
        get project() {
          return state.value
        },
        get snapshot() {
          return state.details
        },
        receivedAt: Date.now(),
        lastSuccessAt: Date.now(),
        connected: true,
        legacy: false,
        locale: "zh",
        t,
      }),
    )
    expect(host.querySelector(".mat-activity-status")?.textContent).toContain("等待模型响应")
    setState({
      value: { ...value, status: "queued", revision: 2 },
      details: {
        ...details,
        status: "queued",
        revision: 2,
        current: previous,
        events: [{ ...previous, id: "previous" }],
      },
    })
    expect(host.querySelector(".mat-activity-status")?.textContent).toBe("等待执行")
    expect(host.querySelector(".mat-activity-role")).toBeNull()
    expect(host.querySelector('[data-field="elapsed"]')).toBeNull()
    expect(host.querySelector('[data-field="output"]')).toBeNull()
    expect(host.textContent).toContain("等待服务器开始本轮操作")
    expect(host.querySelector(".mat-activity-history li")?.textContent).toContain(t(phase))
    await timer.advance(2000)
    expect(host.querySelector('[data-field="elapsed"]')).toBeNull()
    setState({
      value: { ...value, status: "running", revision: 3 },
      details: {
        ...details,
        revision: 3,
        serverTime: Date.now(),
        current: { ...details.current!, phase: "waiting", startedAt: Date.now(), updatedAt: Date.now() },
      },
    })
    expect(host.querySelector(".mat-activity-status")?.textContent).toContain("等待模型响应")
    expect(host.querySelector(".mat-activity-role")?.textContent).toContain("策略构建")
  },
)

test("stale in-flight activity cannot restart a task after cancellation and polling never overlaps", async () => {
  const timer = clock()
  let value = project()
  const deferred = Promise.withResolvers<MaterialActivitySnapshot>()
  const old = snapshot(value)
  old.events = [{ ...old.current!, id: "before-cancel" }]
  let polls = 0
  const request = (async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return (value = { ...value, status: "cancelled", revision: 2 })
    if (path.endsWith("/activity")) {
      polls++
      if (polls === 2) return deferred.promise
      return snapshot(value, {
        events: old.events,
        current: { ...old.current!, phase: value.status === "cancelled" ? "cancelled" : "waiting" },
      })
    }
    return value
  }) as MaterialRequest
  const { host } = mount(() => cardFixture({ projectID: value.id, request, t, locale: "zh" }))
  await flush()
  await timer.advance(2000)
  await timer.advance(4000)
  expect(polls).toBe(2)
  Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent === "停止任务")!
    .click()
  await flush()
  deferred.resolve({ ...old, serverTime: Date.now() })
  await flush()
  expect(host.querySelector(".mat-session-header .mat-badge")?.textContent).toBe("已取消")
  expect(host.querySelector(".mat-activity-status")?.textContent).toContain("已取消")
  expect(host.querySelector(".mat-activity-status")?.textContent).not.toContain("等待模型响应")
  expect(host.querySelector('[data-field="elapsed"]')).toBeNull()
  expect(host.querySelector(".mat-activity-history li")?.textContent).toContain("策略构建")
  await timer.advance(2000)
  expect(polls).toBe(2)
  await timer.advance(8000)
  expect(polls).toBe(3)
})

test("detects a task resumed elsewhere while stopped cards poll less frequently", async () => {
  const timer = clock()
  let value = project({ status: "cancelled" })
  const counts = { full: 0, activity: 0 }
  const request = (async (path: string) => {
    if (path.endsWith("/activity")) {
      counts.activity++
      return snapshot(value)
    }
    counts.full++
    return value
  }) as MaterialRequest
  const { host } = mount(() => cardFixture({ projectID: value.id, request, t, locale: "zh" }))
  await flush()
  await timer.advance(2000)
  expect(counts).toEqual({ full: 1, activity: 1 })
  value = { ...value, status: "running", revision: 2 }
  await timer.advance(8000)
  expect(counts).toEqual({ full: 2, activity: 2 })
  expect(host.querySelector(".mat-session-header .mat-badge")?.textContent).toBe("研究进行中")
  await timer.advance(2000)
  expect(counts).toEqual({ full: 2, activity: 3 })
})

test("falls back to project polling with an explicit notice when an older server has no activity route", async () => {
  const timer = clock()
  const value = project()
  const counts = { full: 0, activity: 0 }
  const request = (async (path: string) => {
    if (path.endsWith("/activity")) {
      counts.activity++
      throw new api.SettingsApiError("not_found", 404)
    }
    counts.full++
    return value
  }) as MaterialRequest
  const { host } = mount(() => cardFixture({ projectID: value.id, request, t, locale: "zh" }))
  await flush()
  expect(host.textContent).toContain("当前服务未提供实时运行详情")
  expect(host.querySelector(".mat-error")).toBeNull()
  await timer.advance(2000)
  expect(counts).toEqual({ full: 3, activity: 1 })
})

test("aborts old project requests and ignores their late responses after switching cards", async () => {
  clock()
  const first = project({ id: "first", title: "First fixture" })
  const second = project({ id: "second", title: "Second fixture" })
  const deferred = Promise.withResolvers<MaterialProject>()
  const [state, setState] = store.createStore({ id: first.id })
  let previous: AbortSignal | undefined
  const request = (async (path: string, init?: RequestInit) => {
    if (path === "/materials/projects/first") {
      previous = init?.signal ?? undefined
      return deferred.promise
    }
    if (path.endsWith("/activity")) return snapshot(second)
    return second
  }) as MaterialRequest
  const { host, dispose } = mount(() =>
    cardFixture({
      get projectID() {
        return state.id
      },
      request,
      t,
      locale: "zh",
    }),
  )
  await flush()
  setState("id", second.id)
  await flush()
  expect(previous?.aborted).toBe(true)
  deferred.resolve(first)
  await flush()
  expect(host.querySelector("h3")?.textContent).toBe("Second fixture")
  expect(host.textContent).not.toContain("First fixture")
  dispose()
})

test("reopening a card restores elapsed time, received characters and execution history from the server", async () => {
  clock()
  const value = project()
  const details = snapshot(value)
  details.current = {
    ...details.current!,
    phase: "generating",
    startedAt: Date.now() - 123_000,
    outputChars: 1234,
    lastModelActivityAt: Date.now() - 1000,
  }
  details.events = [{ ...details.current, id: "event-1" }]
  const request = (async (path: string) => (path.endsWith("/activity") ? details : value)) as MaterialRequest
  const first = mount(() => cardFixture({ projectID: value.id, request, t, locale: "zh" }))
  await flush()
  first.dispose()
  const { host } = mount(() => cardFixture({ projectID: value.id, request, t, locale: "zh" }))
  await flush()
  expect(host.querySelector('[data-field="elapsed"]')?.textContent).toBe("02:03")
  expect(host.querySelector('[data-field="output"]')?.textContent).toBe((1234).toLocaleString())
  expect(host.querySelector(".mat-activity-history summary")?.textContent).toBe("执行记录 · 1")
  expect(host.querySelector(".mat-activity-history li")?.textContent).toContain("策略构建")
})

test.each(["zh", "zht", "en"])("translates the repair role and activity labels for %s", (locale) => {
  clock()
  const value = project()
  const details = snapshot(value)
  details.current = { ...details.current!, role: "ideas:reviewer:repair", phase: "repairing" }
  const translate = (key: Parameters<typeof materialText>[1]) => materialText(locale, key)
  const { host } = mount(() =>
    activity.MaterialActivityPanel({
      project: value,
      snapshot: details,
      connected: true,
      legacy: false,
      receivedAt: Date.now(),
      lastSuccessAt: Date.now(),
      locale,
      t: translate,
    }),
  )
  expect(host.textContent).toContain(translate("activityRepairing"))
  expect(host.textContent).toContain(`${translate("roleIdeaReview")} · ${translate("roleRepair")}`)
  expect(host.textContent).not.toContain("ideas:reviewer:repair")
})

test.each(["zh", "zht", "en"])("shows configured skill execution roles in %s", (locale) => {
  const translate = (key: Parameters<typeof materialText>[1]) => materialText(locale, key)
  expect(activity.activityRole("skill:arxiv", translate)).toBe(`arxiv · ${translate("roleSkill")}`)
  expect(activity.activityRole("skill:semantic-scholar", translate)).toBe(
    `semantic-scholar · ${translate("roleSkill")}`,
  )
  expect(activity.activityRole("skills:literature", translate)).toBe(
    `${translate("literature")} · ${translate("roleSkillExecution")}`,
  )
  expect(activity.activityRole("skills:protocol", translate)).toBe(
    `${translate("protocol")} · ${translate("roleSkillExecution")}`,
  )
  expect(activity.activityRole("skill:unknown", translate)).toBe("")
  expect(activity.activityRole("skills:unknown", translate)).toBe("")
})
