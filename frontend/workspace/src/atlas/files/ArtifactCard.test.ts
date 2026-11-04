import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { createTestServer as createServer } from "../../../test/vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/files/ArtifactCard.tsx") as Promise<typeof import("./ArtifactCard")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const { TestLanguage } = (await server.ssrLoadModule("/test/language.tsx")) as typeof import("../../../test/language")
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        web.createComponent(TestLanguage, {
          get children() {
            return view()
          },
        }),
      host,
    ),
  )
  return host
}

const artifact = (over: { filename: string; mimeType?: string; size?: number; createdAt?: number }) =>
  ({
    schemaVersion: 1,
    id: "art_1",
    projectID: "prj_1",
    title: over.filename,
    kind: "file",
    currentVersionID: "ver_1",
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: 0,
    state: "active",
    versionCount: 1,
    current: {
      id: "ver_1",
      artifactID: "art_1",
      version: 1,
      filename: over.filename,
      mimeType: over.mimeType ?? "application/octet-stream",
      size: over.size ?? 100,
      sha256: "abc",
      sessionID: "ses_1",
      sourcePath: `/tmp/${over.filename}`,
      captureQuality: "exact",
      createdAt: 0,
    },
  }) as never

const props = (over: Record<string, unknown> = {}) => ({
  artifact: artifact({ filename: "train.py" }),
  layout: "grid" as const,
  sizes: false,
  read: async () => new Blob(["import numpy"]),
  highlight: async (code: string) => code,
  onOpen: () => {},
  onDownload: () => {},
  onRename: () => {},
  onTrash: () => {},
  ...over,
})

describe("artifact card", () => {
  // A control inside a control is invalid, and its label folds into the outer
  // control's accessible name. This pane has had that defect fixed twice.
  test("keeps the actions trigger a sibling of the open control", () => {
    const host = mount(() => subject.ArtifactCard(props() as never))
    const open = host.querySelector("[data-card-open]")
    const menu = host.querySelector("[data-card-menu]")

    expect(open).not.toBeNull()
    expect(menu).not.toBeNull()
    expect(open!.contains(menu!)).toBe(false)
    expect(open!.getAttribute("aria-label")).toBe("Open train.py, version 1")
    expect(menu!.getAttribute("aria-label")).toBe("Actions for train.py")
  })

  test("opens on click and from the menu, and reports trash", () => {
    const opened: string[] = []
    const trashed: string[] = []
    const host = mount(() =>
      subject.ArtifactCard(
        props({
          onOpen: (item: { title: string }) => opened.push(item.title),
          onTrash: (item: { title: string }) => trashed.push(item.title),
        }) as never,
      ),
    )

    host.querySelector<HTMLButtonElement>("[data-card-open]")!.click()
    host.querySelector<HTMLButtonElement>("[data-card-menu]")!.click()
    host.querySelector<HTMLButtonElement>("[data-action='open']")!.click()
    host.querySelector<HTMLButtonElement>("[data-card-menu]")!.click()
    host.querySelector<HTMLButtonElement>("[data-action='trash']")!.click()

    expect(opened).toEqual(["train.py", "train.py"])
    expect(trashed).toEqual(["train.py"])
  })

  test("closes the menu once an action is taken", () => {
    const host = mount(() => subject.ArtifactCard(props() as never))

    host.querySelector<HTMLButtonElement>("[data-card-menu]")!.click()
    expect(host.querySelector("[role='menu']")).not.toBeNull()

    host.querySelector<HTMLButtonElement>("[data-action='rename']")!.click()

    expect(host.querySelector("[role='menu']")).toBeNull()
    expect(host.querySelector("[data-card-menu]")?.getAttribute("aria-expanded")).toBe("false")
  })

  test("moves focus within actions and Escape returns to its trigger without dismissing the host", async () => {
    const host = mount(() => subject.ArtifactCard(props() as never))
    const escaped: KeyboardEvent[] = []
    web.spread(host, {
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Escape") escaped.push(event)
      },
    })
    const trigger = host.querySelector<HTMLButtonElement>("[data-card-menu]")!
    trigger.click()
    await Promise.resolve()
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(document.activeElement).toBe(options[0])

    options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(document.activeElement).toBe(options[1])
    options[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(document.activeElement).toBe(options.at(-1)!)
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(document.activeElement).toBe(options[0])
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    expect(document.activeElement).toBe(options.at(-1)!)

    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await Promise.resolve()
    expect(host.querySelector("[role='menu']")).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(escaped).toHaveLength(0)
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(escaped).toHaveLength(1)
  })

  // The menu is wider than a grid cell. Anchored inside the card it rendered at
  // left: -16px in a real browser, where the pane's overflow: hidden cut it off,
  // so it is placed in script against the viewport instead.
  test("places the menu rather than letting it inherit the card's box", () => {
    const host = mount(() => subject.ArtifactCard(props() as never))

    host.querySelector<HTMLButtonElement>("[data-card-menu]")!.click()
    const menu = host.querySelector<HTMLElement>("[role='menu']")!

    expect(menu.style.visibility).toBe("visible")
    expect(menu.style.left).not.toBe("")
    expect(menu.style.top).not.toBe("")
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0)
  })

  test("delegates Download without exposing a raw artifact URL", () => {
    const asked: string[] = []
    const host = mount(() =>
      subject.ArtifactCard(
        props({
          onDownload: (item: { id: string }) => asked.push(item.id),
        }) as never,
      ),
    )
    host.querySelector<HTMLButtonElement>("[data-card-menu]")!.click()
    host.querySelector<HTMLButtonElement>("[data-action='download']")!.click()

    expect(asked).toEqual(["art_1"])
    expect(host.querySelector("[data-action='download']")).toBeNull()
    expect(host.querySelector("a[href*='/raw']")).toBeNull()
  })

  test("keeps report and companion actions separate and passes each original artifact", () => {
    const material = (id: string, format: "md" | "json"): StoredArtifact => {
      const item: StoredArtifact = artifact({ filename: `ideas.${format}` })
      return {
        ...item,
        id,
        title: format === "md" ? "My renamed BZO report" : "BZO research data",
        currentVersionID: `ver_card_${id}`,
        current: {
          ...item.current,
          id: `ver_card_${id}`,
          artifactID: id,
          mimeType: format === "md" ? "text/markdown" : "application/json",
          sourcePath: `materials/mat_card/reports/ideas.${format}`,
        },
      }
    }
    const report = material("art_card_report", "md")
    const data = material("art_card_data", "json")
    const opened: StoredArtifact[] = []
    const downloaded: StoredArtifact[] = []
    const renamed: StoredArtifact[] = []
    const trashed: StoredArtifact[] = []
    const host = mount(() =>
      subject.ArtifactCard(
        props({
          artifact: report,
          companion: data,
          onOpen: (item: StoredArtifact) => opened.push(item),
          onDownload: (item: StoredArtifact) => downloaded.push(item),
          onRename: (item: StoredArtifact) => renamed.push(item),
          onTrash: (item: StoredArtifact) => trashed.push(item),
        }) as never,
      ),
    )

    const open = host.querySelector<HTMLButtonElement>("[data-card-open]")!
    const companion = host.querySelector<HTMLButtonElement>("[data-card-companion]")!
    expect(host.querySelector(".artifact-card__name")?.textContent).toBe(report.title)
    expect(open.contains(companion)).toBe(false)
    expect(companion.getAttribute("aria-label")).toBe(`Open data: ${data.title}`)
    open.click()
    companion.click()
    for (const action of [
      "open",
      "open-data",
      "download",
      "download-data",
      "rename",
      "rename-data",
      "trash",
      "trash-data",
    ]) {
      host.querySelector<HTMLButtonElement>("[data-card-menu]")!.click()
      host.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!.click()
      expect(host.querySelector("[role='menu']")).toBeNull()
    }

    expect(opened).toHaveLength(4)
    expect(opened[0]).toBe(report)
    expect(opened[1]).toBe(data)
    expect(opened[2]).toBe(report)
    expect(opened[3]).toBe(data)
    for (const requested of [downloaded, renamed, trashed]) {
      expect(requested).toHaveLength(2)
      expect(requested[0]).toBe(report)
      expect(requested[1]).toBe(data)
    }
  })

  test("shows the size only when asked", () => {
    const plain = mount(() => subject.ArtifactCard(props() as never))
    expect(plain.querySelector("[data-card-meta]")?.textContent).not.toContain("100 B")

    cleanups.splice(0).forEach((fn) => fn())
    document.body.replaceChildren()

    const sized = mount(() => subject.ArtifactCard(props({ sizes: true }) as never))
    expect(sized.querySelector("[data-card-meta]")?.textContent).toContain("100 B")
  })

  test("shows the current immutable version without adding a decorative badge", () => {
    const item = artifact({ filename: "report.md" }) as unknown as {
      versionCount: number
      current: { version: number }
    }
    item.versionCount = 4
    item.current.version = 4
    const host = mount(() => subject.ArtifactCard(props({ artifact: item }) as never))

    expect(host.querySelector("[data-card-version]")?.textContent).toBe("Version 4 of 4")
    expect(host.querySelector("[data-card-open]")?.getAttribute("aria-label")).toContain("version 4 of 4")
    expect(host.querySelector("[data-card-version] svg")).toBeNull()
  })

  test("carries its layout so the grid and list can style one component", () => {
    const host = mount(() => subject.ArtifactCard(props({ layout: "list" }) as never))

    expect(host.querySelector(".artifact-card")?.getAttribute("data-layout")).toBe("list")
  })
})
