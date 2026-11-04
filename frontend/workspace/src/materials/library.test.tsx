import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import type { MaterialLibrarySnapshot, MaterialProject } from "@synsci/util/materials"
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
const subject = (await server.ssrLoadModule("/src/materials/library.tsx")) as typeof import("./library")
const api = (await server.ssrLoadModule(
  "/src/components/settings/api.ts",
)) as typeof import("@/components/settings/api")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const store = (await server.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const cleanups: (() => void)[] = []
afterAll(() => server.close())
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
  document.body.replaceChildren()
})
const t = (key: Parameters<typeof materialText>[1]) => materialText("zh", key)
const flush = async () => {
  await Bun.sleep(0)
  await Bun.sleep(0)
}
function mount(view: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(view, host)
  cleanups.push(dispose)
  return { host, dispose }
}
const project = { id: "mat_one", revision: 3 } as MaterialProject
function snapshot(overrides: Partial<MaterialLibrarySnapshot> = {}): MaterialLibrarySnapshot {
  return {
    materialsProjectID: project.id,
    status: "synced",
    revision: 3,
    projectID: "prj_one",
    sessionID: "ses_one",
    directory: "/project",
    root: "/working/materials/mat_one",
    location: "working",
    files: [
      {
        kind: "report",
        title: "Plan v1",
        path: "/working/materials/mat_one/plan.md",
        mimeType: "text/markdown",
        resultID: "art_one",
        resultVersionID: "av_one",
      },
    ],
    warnings: [],
    ...overrides,
  }
}
const button = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll("button")).find((item) => item.textContent === text)!
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

test("reads metadata, reveals existing file/result navigation and syncs only on explicit action", async () => {
  const calls: RequestInit[] = [],
    opened: unknown[] = []
  const state = snapshot()
  const { host } = mount(() =>
    subject.MaterialLibraryPanel({
      project,
      refreshKey: 0,
      t,
      request: (async (_path, init) => {
        calls.push(init!)
        return state
      }) as MaterialRequest,
      navigation: {
        directory: (value) => {
          opened.push(["directory", value.root])
        },
        results: (value) => {
          opened.push(["results", value.projectID])
        },
        file: (_value, file) => {
          opened.push(["file", file.path])
        },
        result: (_value, file) => {
          opened.push(["result", file.resultID, file.resultVersionID])
        },
      },
    }),
  )
  await flush()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.method).toBeUndefined()
  expect(host.textContent).toContain(state.root!)
  expect(host.textContent).toContain("已同步")
  for (const label of ["打开保存目录", "打开成果面板", "打开文件", "查看成果版本"]) button(host, label).click()
  await flush()
  expect(opened).toEqual([
    ["directory", state.root],
    ["results", "prj_one"],
    ["file", state.files[0]!.path],
    ["result", "art_one", "av_one"],
  ])
  button(host, "同步已有资料与成果").click()
  await flush()
  expect(calls).toHaveLength(2)
  expect(calls[1]!.method).toBe("POST")
  expect(calls[1]!.body).toBe("{}")
})

test("coalesces revision changes, refreshes results only on version changes, and preserves files after a failed read", async () => {
  const [state, setState] = store.createStore({ project: { ...project }, refreshKey: 0 })
  const pending = deferred<MaterialLibrarySnapshot>()
  let reads = 0,
    events = 0
  const changed = () => events++
  window.addEventListener("openscience:artifacts-changed", changed)
  cleanups.push(() => window.removeEventListener("openscience:artifacts-changed", changed))
  const { host } = mount(() =>
    subject.MaterialLibraryPanel({
      get project() {
        return state.project
      },
      get refreshKey() {
        return state.refreshKey
      },
      t,
      request: (async () => {
        reads++
        if (reads === 1) return pending.promise
        if (reads === 4) throw new Error("Offline")
        return snapshot({
          revision: 5,
          ...(reads === 3 ? { files: [{ ...snapshot().files[0]!, resultVersionID: "av_two" }] } : {}),
        })
      }) as MaterialRequest,
    }),
  )
  setState("project", "revision", 4)
  setState("project", "revision", 5)
  expect(reads).toBe(1)
  pending.resolve(snapshot())
  await flush()
  expect(reads).toBe(2)
  expect(events).toBe(1)
  setState("refreshKey", 1)
  await flush()
  expect(events).toBe(2)
  setState("refreshKey", 2)
  await flush()
  expect(host.textContent).toContain("Offline")
  expect(host.textContent).toContain("Plan v1")
})

test("ignores and aborts a late snapshot after changing projects or unmounting", async () => {
  const [state, setState] = store.createStore({ project: { ...project } })
  const pending = deferred<MaterialLibrarySnapshot>()
  const signals: AbortSignal[] = []
  const { host, dispose } = mount(() =>
    subject.MaterialLibraryPanel({
      get project() {
        return state.project
      },
      refreshKey: 0,
      t,
      request: (async (_path, init) => {
        signals.push(init!.signal!)
        return signals.length === 1
          ? pending.promise
          : snapshot({ materialsProjectID: "mat_two", root: "/working/two", files: [] })
      }) as MaterialRequest,
    }),
  )
  setState("project", { ...project, id: "mat_two" })
  await flush()
  expect(signals[0]!.aborted).toBe(true)
  pending.resolve(snapshot())
  await flush()
  expect(host.textContent).toContain("/working/two")
  expect(host.textContent).not.toContain("/working/materials/mat_one")
  dispose()
  expect(host.textContent).toBe("")
})

test("reports old services and initial failures without staying on loading", async () => {
  const first = mount(() =>
    subject.MaterialLibraryPanel({
      project,
      refreshKey: 0,
      t,
      request: (async () => {
        throw new api.SettingsApiError("Not found", 404)
      }) as MaterialRequest,
    }),
  )
  await flush()
  expect(first.host.textContent).toContain("当前服务不支持文件同步")
  expect(button(first.host, "同步已有资料与成果").disabled).toBe(true)
  const second = mount(() =>
    subject.MaterialLibraryPanel({
      project,
      refreshKey: 0,
      t,
      request: (async () => {
        throw new Error("Disconnected")
      }) as MaterialRequest,
    }),
  )
  await flush()
  expect(second.host.querySelector('[role="status"]')?.textContent).toBe("文件同步未完成")
  expect(second.host.textContent).toContain("Disconnected")
})

test("polls a still-running background sync and stops once its revision is synchronized", async () => {
  const original = globalThis.setTimeout
  const callbacks: (() => void)[] = []
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 10000 || delay === 15000) {
      callbacks.push(handler as () => void)
      return 987654 as any
    }
    return original(handler, delay, ...args)
  }) as typeof setTimeout)
  cleanups.push(() => timer.mockRestore())
  let reads = 0
  const { host } = mount(() =>
    subject.MaterialLibraryPanel({
      project,
      refreshKey: 0,
      t,
      request: (async () => {
        reads++
        return snapshot({ status: reads === 1 ? "syncing" : "synced" })
      }) as MaterialRequest,
    }),
  )
  await flush()
  expect(callbacks).toHaveLength(1)
  callbacks.shift()!()
  await flush()
  expect(reads).toBe(2)
  expect(callbacks).toHaveLength(0)
  expect(host.textContent).toContain("已同步")
})

test("keeps checking background synchronization when the manual POST response is lost", async () => {
  const original = globalThis.setTimeout
  const callbacks: (() => void)[] = []
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 10000 || delay === 15000) {
      callbacks.push(handler as () => void)
      return 987655 as any
    }
    return original(handler, delay, ...args)
  }) as typeof setTimeout)
  cleanups.push(() => timer.mockRestore())
  let reads = 0
  const { host } = mount(() =>
    subject.MaterialLibraryPanel({
      project,
      refreshKey: 0,
      t,
      request: (async (_path, init) => {
        if (init?.method === "POST") throw new Error("Response lost")
        reads++
        return snapshot({ status: reads === 2 ? "syncing" : "synced" })
      }) as MaterialRequest,
    }),
  )
  await flush()
  expect(callbacks).toHaveLength(0)
  button(host, "同步已有资料与成果").click()
  await flush()
  expect(host.textContent).toContain("Response lost")
  expect(callbacks).toHaveLength(1)
  callbacks.shift()!()
  await flush()
  expect(host.textContent).toContain("正在同步文件")
  callbacks.shift()!()
  await flush()
  expect(reads).toBe(3)
  expect(callbacks).toHaveLength(0)
  expect(host.textContent).toContain("已同步")
})
