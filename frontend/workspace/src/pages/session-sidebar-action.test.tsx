import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"

const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web, fixture, solidjs, store] = await Promise.all([
  server.ssrLoadModule("/src/pages/session-sidebar-action.tsx") as Promise<typeof import("./session-sidebar-action")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  server.ssrLoadModule("/src/pages/language.fixture.tsx") as Promise<typeof import("./language.fixture")>,
  server.ssrLoadModule("solid-js") as Promise<typeof import("solid-js")>,
  server.ssrLoadModule("/src/atlas/store/ui.ts") as Promise<typeof import("@/atlas/store/ui")>,
])
const { createComponent, createSignal } = solidjs
const { createContextState } = store
const { LanguageFixture } = fixture
const render = web.render

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    render(
      () =>
        createComponent(LanguageFixture, {
          get children() {
            return view()
          },
        }),
      host,
    ),
  )
  return host
}

const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe("SessionSidebarActions", () => {
  test("invokes the current callback supplied by its parent", async () => {
    const calls: string[] = []
    const [action, setAction] = createSignal(() => calls.push("initial"))
    const host = mount(() =>
      createComponent(subject.SidebarAction, {
        label: "Files",
        detail: "Project files",
        ariaLabel: "Open project files",
        get onClick() {
          return action()
        },
        children: "F",
      }),
    )
    setAction(() => () => calls.push("current"))
    button(host, "Open project files")!.click()
    expect(calls).toEqual(["current"])
  })

  test("keeps Files, Terminal, and Compute reachable in the compact menu", async () => {
    const state = createContextState()
    const compact = mount(() =>
      createComponent(subject.CompactContextActions, {
        get context() {
          return state.context()
        },
        get contextOpen() {
          return state.open()
        },
        onContext: state.openContext,
      }),
    )
    const menu = (label: string) =>
      Array.from(compact.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')).find(
        (item) => item.textContent?.trim() === label,
      )

    menu("Files")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)

    menu("Terminal")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("terminal")
    expect(state.open()).toBe(true)

    menu("Compute")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("kernels")
    expect(menu("Gateway")).toBeUndefined()
    expect(menu("Evidence")).toBeUndefined()
    expect(menu("Trace")).toBeUndefined()

    const connected = mount(() =>
      createComponent(subject.CompactContextActions, { context: "kernels", contextOpen: true, onContext() {} }),
    )
    expect(
      Array.from(connected.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
        .find((item) => item.textContent?.trim() === "Compute")
        ?.getAttribute("aria-pressed"),
    ).toBe("true")
    expect(connected.textContent).not.toContain("Gateway")
    expect(connected.textContent).not.toContain("Trace")
  })

  test("never exposes Gateway or Trace in public project navigation", async () => {
    const hidden = mount(() =>
      createComponent(subject.SessionSidebarActions, { context: "trace", contextOpen: true, onContext() {} }),
    )
    const canvas = mount(() =>
      createComponent(subject.SessionSidebarActions, { context: "canvas", contextOpen: true, onContext() {} }),
    )

    expect(button(hidden, "Open session trace")).toBeNull()
    expect(button(canvas, "Open Gateway")).toBeNull()
  })

  test("keeps rail labels semantic while visual density stays in the shell CSS", async () => {
    const action = mount(() =>
      createComponent(subject.SidebarAction, {
        label: "New research",
        detail: "Start a session",
        ariaLabel: "New research",
        shortcut: "⌘N",
        onClick() {},
        children: document.createElement("span"),
      }),
    )
    const actions = mount(() =>
      createComponent(subject.SessionSidebarActions, { context: "canvas", contextOpen: false, onContext() {} }),
    )

    expect(action.querySelector(".session-sidebar__action-copy strong")?.textContent).toBe("New research")
    expect(action.querySelector(".session-sidebar__action-copy > span")?.textContent).toBe("Start a session")
    expect(action.querySelector("kbd")?.textContent).toBe("⌘N")
    expect(button(action, "New research")?.dataset.tooltip).toBe("New research")
    expect(button(action, "New research")?.hasAttribute("title")).toBe(false)
    expect(actions.querySelector(".session-sidebar__group-label")?.textContent?.trim()).toBe("Workspace")
  })

  test("opens contextual surfaces without toggling the active surface closed", async () => {
    expect(subject.SessionSidebarActions).toBeDefined()
    if (!subject.SessionSidebarActions) return

    const state = createContextState()
    const host = mount(() =>
      createComponent(subject.SessionSidebarActions, {
        get context() {
          return state.context()
        },
        get contextOpen() {
          return state.open()
        },
        onContext: state.openContext,
      }),
    )

    button(host, "Open project files")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)

    button(host, "Open project terminal")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("terminal")
    expect(state.open()).toBe(true)

    button(host, "Open project compute")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("kernels")

    const selected = mount(() =>
      createComponent(subject.SessionSidebarActions, { context: "canvas", contextOpen: true, onContext() {} }),
    )
    expect(button(selected, "Open Gateway")).toBeNull()
    expect(button(selected, "Open project terminal")).not.toBeNull()
    expect(button(selected, "Open Evidence")).toBeNull()

    const files = mount(() =>
      createComponent(subject.SessionSidebarActions, { context: "files", contextOpen: true, onContext() {} }),
    )
    expect(button(files, "Open project files")?.getAttribute("aria-pressed")).toBe("true")
    expect(button(files, "Open Gateway")).toBeNull()
  })

  test("keeps file details and provenance out of project navigation", async () => {
    expect(subject.SessionSidebarActions).toBeDefined()
    if (!subject.SessionSidebarActions) return

    const navigation = mount(() =>
      createComponent(subject.SessionSidebarActions, { context: "files", contextOpen: true, onContext() {} }),
    )

    expect(button(navigation, "Open file details")).toBeNull()
    expect(navigation.textContent).not.toContain("Provenance")
  })
})
