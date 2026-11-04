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
  server.ssrLoadModule("/src/atlas/files/ArtifactThumb.tsx") as Promise<typeof import("./ArtifactThumb")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const { TestLanguage } = (await server.ssrLoadModule("/test/language.tsx")) as typeof import("../../../test/language")
const store = (await server.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// Loading a shiki grammar takes longer than a microtask and longer on a cold
// machine than a warm one, so the real-highlighter test waits for the condition
// rather than for a duration it would have to guess at.
const waitFor = async <T>(read: () => T | null | undefined, timeout = 15_000) => {
  const until = Date.now() + timeout
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > until) return undefined
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

let versions = 0
const artifact = (over: { filename: string; mimeType?: string; size?: number }) =>
  ({
    schemaVersion: 1,
    id: "art_1",
    projectID: "prj_1",
    title: over.filename,
    kind: "file",
    currentVersionID: "ver_1",
    createdAt: 0,
    updatedAt: 0,
    state: "active",
    versionCount: 1,
    current: {
      id: `ver_${(versions += 1)}`,
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

describe("artifact thumbnail", () => {
  test("renders an image from authenticated bytes, never a raw URL", async () => {
    let reads = 0
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "fit.png", mimeType: "image/png" }),
        read: async () => {
          reads += 1
          return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })
        },
      }),
    )
    const image = await waitFor(() => host.querySelector("img"))

    expect(reads).toBe(1)
    expect(image?.getAttribute("src")).toStartWith("data:image/png;base64,")
    expect(image?.getAttribute("src")).not.toContain("/raw")
  })

  test("falls back to the extension when authenticated image bytes cannot be read", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "fit.png", mimeType: "image/png" }),
        read: async () => {
          throw new Error("gone")
        },
      }),
    )
    await settle()

    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("png")
  })

  test("shows the first ten lines, tinted", async () => {
    const body = Array.from({ length: 20 }, (unused, index) => `line ${index}`).join("\n")
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        read: async () => new Blob([body]),
        highlight: async (code) => `<span class="tinted">${code}</span>`,
      }),
    )
    await settle()

    expect(host.querySelector(".tinted")?.textContent).toContain("line 0")
    expect(host.querySelector(".tinted")?.textContent).toContain("line 9")
    expect(host.querySelector(".tinted")?.textContent).not.toContain("line 10")
  })

  test("renders Markdown and structured prose as inert readable text without highlighting", async () => {
    let highlights = 0
    const highlight = async () => {
      highlights += 1
      return ""
    }
    const markdown = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "report.md", mimeType: "text/markdown" }),
        read: async () => new Blob(["# 研究报告\n\n**待验证**的材料方案。\n\n&lt;img src=x onerror=alert(1)&gt;"]),
        highlight,
      }),
    )
    const structured = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "ideas.json", mimeType: "application/json" }),
        read: async () => new Blob([JSON.stringify({ ideas: [{ hypothesis: "增加对照实验，以检验假设。" }] })]),
        highlight,
      }),
    )
    await settle()
    expect(markdown.querySelector("[data-thumb-summary]")?.textContent).toContain("待验证的材料方案。")
    expect(markdown.querySelector("[data-thumb-summary]")?.textContent).not.toContain("研究报告")
    expect(markdown.querySelector("img")).toBeNull()
    expect(structured.querySelector("[data-thumb-summary]")?.textContent).toContain("增加对照实验，以检验假设。")
    expect(structured.querySelector("[data-thumb-stat]")?.textContent).toBe("1 items")
    expect(highlights).toBe(0)
  })

  test("a slow previous artifact cannot replace the current summary or corrupt its version cache", async () => {
    const previous = artifact({ filename: "old.md", mimeType: "text/markdown" }) as StoredArtifact
    const current = artifact({ filename: "current.json", mimeType: "application/json" }) as StoredArtifact
    const [state, setState] = store.createStore({ current: false })
    let release: (value: Blob) => void = () => {}
    const host = mount(() =>
      subject.ArtifactThumb({
        get artifact() {
          return state.current ? current : previous
        },
        read: (item) =>
          item.current.filename === "old.md"
            ? new Promise<Blob>((resolve) => {
                release = resolve
              })
            : Promise.resolve(new Blob(['{"objective":"当前版本的研究目标。"}'])),
      }),
    )
    setState("current", true)
    await settle()
    release(new Blob(["# 旧报告\n\n旧版本的研究内容。"]))
    await settle()
    expect(host.querySelector("[data-thumb-summary]")?.textContent).toBe("当前版本的研究目标。")
    setState("current", false)
    await settle()
    expect(host.querySelector(".artifact-thumb--document")?.textContent).toBe("旧版本的研究内容。")
  })

  test("uses workflow excerpts only for a verified materials artifact", async () => {
    const material = artifact({ filename: "ideas.md", mimeType: "text/markdown" }) as StoredArtifact
    material.currentVersionID = material.current.id
    material.current.sourcePath = "materials/mat_abc123/reports/ideas.md"
    const body = "# 创新方案\n\n记录角色 review 与 rank。\n\n## 1. 首个候选\n\n待验证的材料假设。"
    const verified = mount(() => subject.ArtifactThumb({ artifact: material, read: async () => new Blob([body]) }))
    const ordinary = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "ideas.md", mimeType: "text/markdown" }),
        read: async () => new Blob([body]),
      }),
    )
    await settle()
    expect(verified.querySelector("[data-thumb-summary]")?.textContent).toBe("首个候选待验证的材料假设。")
    expect(ordinary.querySelector("[data-thumb-summary]")?.textContent).toContain("记录角色 review 与 rank。")
  })

  // The rule the Compute strip established: a degraded tile, never an error page.
  test("falls back to the extension when the read fails", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        read: async () => {
          throw new Error("gone")
        },
      }),
    )
    await settle()

    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("py")
  })

  test("falls back to plain text when highlighting fails", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        read: async () => new Blob(["import numpy"]),
        highlight: async () => {
          throw new Error("no grammar")
        },
      }),
    )
    await settle()

    expect(host.querySelector("[data-thumb-text]")?.textContent).toContain("import numpy")
  })

  test("does not read an artifact past the preview limit", async () => {
    let reads = 0
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "huge.md", mimeType: "text/markdown", size: 70_000 }),
        read: async () => {
          reads += 1
          return new Blob(["never"])
        },
      }),
    )
    await settle()

    expect(reads).toBe(0)
    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("md")
  })

  test("does not read an image past the in-memory preview limit", async () => {
    let reads = 0
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "huge.png", mimeType: "image/png", size: 8 * 1024 * 1024 + 1 }),
        read: async () => {
          reads += 1
          return new Blob(["never"])
        },
      }),
    )
    await settle()

    expect(reads).toBe(0)
    expect(host.querySelector("[data-thumb-chip]")?.textContent).toBe("png")
  })

  // Every other test injects `highlight`, which would let a wrong export name or
  // a wrong module specifier pass the suite and fail only in a browser. This one
  // runs the real shared highlighter, so the wiring itself is under test.
  test("tints with the shared highlighter when none is injected", async () => {
    const host = mount(() =>
      subject.ArtifactThumb({
        artifact: artifact({ filename: "train.py" }),
        read: async () => new Blob(['import numpy as np\nname = "x"\n']),
      }),
    )

    const tinted = await waitFor(() => host.querySelector("[data-thumb-text] span[style*='--syntax-']"))

    expect(tinted).toBeTruthy()
    expect(host.querySelector("[data-thumb-text]")?.textContent).toContain("import numpy as np")
    expect(host.querySelector("[data-thumb-text]")?.textContent).toContain('\nname = "x"')
  }, 20_000)
})
