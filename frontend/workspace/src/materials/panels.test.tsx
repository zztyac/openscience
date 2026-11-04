import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import type { MaterialProject } from "@synsci/util/materials"
import { createTestServer } from "../../test/vite"
import solid from "vite-plugin-solid"
import { materialText } from "./i18n"
import type { PanelProps } from "./panels"

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
const [subject, card, api, web, solidStore, files] = await Promise.all([
  server.ssrLoadModule("/src/materials/panels.tsx") as Promise<typeof import("./panels")>,
  server.ssrLoadModule("/src/materials/session-card.tsx") as Promise<typeof import("./session-card")>,
  server.ssrLoadModule("/src/components/settings/api.ts") as Promise<typeof import("@/components/settings/api")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  server.ssrLoadModule("solid-js/store") as Promise<typeof import("solid-js/store")>,
  server.ssrLoadModule("/src/materials/files.ts") as Promise<typeof import("./files")>,
])
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
function mount(view: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}
function project(): MaterialProject {
  return {
    id: "test-project",
    workspaceID: "default",
    title: "REBCO",
    goal: "Improve critical current with verifiable evidence",
    domain: "rebco",
    target: "protocol",
    status: "needs_input",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    answers: "",
    questions: ["What temperature?"],
    stages: [],
    sources: [],
    artifacts: [],
    batches: [],
    events: [],
    selectedIdeaIDs: [],
  }
}
const t = (key: Parameters<PanelProps["t"]>[0]) => materialText("zh", key)
function props(value: MaterialProject, overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    project: value,
    t,
    locale: "zh",
    busy: false,
    action: async () => true,
    saveSource: async () => true,
    saveBatch: async () => true,
    ...overrides,
  }
}
const protocolData = {
  title: "Controlled REBCO",
  ideaIDs: ["idea1"],
  objective: "Test pinning",
  groups: [{ id: "control", name: "Control", purpose: "Baseline", variables: "No dopant", replicates: 3 }],
  steps: [{ order: 1, instruction: "Prepare samples", rationale: "Matched comparison" }],
  parameters: [],
  measurements: ["Jc"],
  successCriteria: ["Compare like conditions"],
  risks: [],
  confirmations: ["Confirm temperature"],
}
function protocolProject(): MaterialProject {
  return {
    ...project(),
    status: "awaiting_approval",
    artifacts: [
      {
        id: "protocol1",
        stage: "protocol",
        title: "Controlled REBCO",
        version: 1,
        createdAt: 1,
        markdown: "",
        data: protocolData,
        inputArtifactIDs: [],
      },
    ],
  }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("materials research panels", () => {
  test("retries full-text retrieval from the existing literature panel before evidence is fixed", async () => {
    const ready: MaterialProject = {
      ...project(),
      status: "failed",
      questions: [],
      stages: [{ key: "intake", status: "completed" }],
    }
    const [store, setStore] = solidStore.createStore({ project: ready, busy: false })
    const decisions: unknown[] = []
    const host = mount(() =>
      subject.Sources({
        ...props(ready),
        get project() {
          return store.project
        },
        get busy() {
          return store.busy
        },
        action: async (value) => {
          decisions.push(value)
          return true
        },
      }),
    )
    const button = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === "重新获取全文")
    expect(host.textContent).toContain("完成后按原研究目标继续执行")
    button()!.click()
    await flush()
    expect(decisions).toEqual([{ action: "refresh_literature" }])
    setStore("busy", true)
    expect(button()?.disabled).toBe(true)
    setStore("busy", false)
    for (const status of ["running", "queued"] as const) {
      setStore("project", { ...ready, status })
      expect(button()).toBeUndefined()
    }
    setStore("project", { ...ready, stages: [{ key: "intake", status: "pending" }] })
    expect(button()).toBeUndefined()
    setStore("project", { ...ready, questions: ["尚未确认的研究问题"] })
    expect(button()).toBeUndefined()
    setStore("project", {
      ...ready,
      artifacts: [
        {
          id: "strategy",
          stage: "strategies",
          title: "Strategies",
          version: 1,
          createdAt: 1,
          markdown: "",
          data: {},
          inputArtifactIDs: [],
        },
      ],
    })
    expect(button()).toBeUndefined()
    expect(host.textContent).toContain("策略已生成，证据集合已固定")
    setStore("project", { ...ready, approvedProtocolID: "approved" })
    expect(button()).toBeUndefined()
  })
  test("distinguishes full text, partial text and unavailable full text with extraction details", () => {
    const base = { authors: "A. Researcher", origin: "openalex" as const, createdAt: 1 }
    const host = mount(() =>
      subject.Sources(
        props({
          ...project(),
          sources: [
            {
              ...base,
              id: "full",
              title: "Complete paper",
              kind: "fulltext",
              text: "Full source text. ".repeat(500),
              url: "https://doi.org/10.0000/example",
              retrieval: {
                status: "fulltext",
                attemptedAt: 1,
                pageCount: 10,
                url: "https://papers.example.org/full.pdf",
              },
              chunks: [
                { id: "p1", page: 1, text: "The first verifiable passage." },
                { id: "p2", page: 2, text: "The second verifiable passage." },
              ],
            },
            {
              ...base,
              id: "partial",
              title: "Partial paper",
              kind: "partial",
              text: "Extracted text from the available pages.",
              retrieval: { status: "partial", attemptedAt: 1, reason: "部分页面未能提取文字。" },
            },
            {
              ...base,
              id: "abstract",
              title: "Abstract only",
              kind: "abstract",
              text: "Only the indexed abstract is available.",
              retrieval: { status: "unavailable", attemptedAt: 1, reason: "未发现可访问的开放全文。" },
            },
          ],
        }),
      ),
    )
    const sources = host.querySelectorAll(".mat-source")
    expect(Array.from(sources, (source) => source.querySelector(".mat-type")?.textContent)).toEqual([
      "论文全文",
      "部分正文",
      "论文摘要",
    ])
    expect(sources[0].querySelector("summary")?.textContent).toContain("页数: 10 · 证据片段数: 2")
    expect(sources[0].querySelector("a")?.getAttribute("href")).toBe("https://papers.example.org/full.pdf")
    expect(sources[0].querySelector("pre")?.textContent?.length).toBe(6000)
    expect(sources[0].textContent).toContain("此处仅显示原文节选。")
    expect(sources[1].textContent).toContain("部分页面未能提取文字。")
    expect(sources[2].textContent).toContain("未获取到全文，当前仅有摘要。")
    expect(sources[2].textContent).toContain("未发现可访问的开放全文。")
    expect(Array.from(host.querySelectorAll("select option"), (option) => option.getAttribute("value"))).toEqual([
      "fulltext",
      "abstract",
      "note",
    ])
  })
  test("shows a cited passage's page and surrounding text with its retrieved paper link", () => {
    const host = mount(() =>
      subject.Evidence({
        t,
        project: {
          ...project(),
          sources: [
            {
              id: "paper",
              title: "REBCO pinning study",
              authors: "",
              origin: "openalex",
              createdAt: 1,
              kind: "fulltext",
              text: "Original full text with a traceable result.",
              retrieval: { status: "fulltext", attemptedAt: 1, url: "https://papers.example.org/result.pdf" },
              chunks: [
                { id: "intro", page: 1, text: "Paper introduction." },
                {
                  id: "result",
                  page: 4,
                  text: "At 77 K, the measured critical current improved under matched conditions.",
                },
              ],
            },
          ],
        },
        evidence: { sourceID: "paper", chunkID: "result", quote: "the measured critical current improved" },
      }),
    )
    expect(host.querySelector("summary")?.textContent).toContain("页 4 · 证据片段 2")
    expect(host.querySelector("blockquote")?.textContent).toBe("the measured critical current improved")
    expect(host.querySelector(".mat-evidence-context")?.textContent).toContain("At 77 K")
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://papers.example.org/result.pdf")
  })
  test("keeps partial text distinct from an abstract after a failed retrieval retry", () => {
    const host = mount(() =>
      subject.Sources(
        props({
          ...project(),
          sources: [
            {
              id: "partial",
              title: "Previously extracted pages",
              authors: "",
              origin: "openalex",
              createdAt: 1,
              kind: "partial",
              text: "Useful partial text remains available after a failed retry.",
              chunks: [{ id: "saved", page: 2, text: "Useful partial text remains available after a failed retry." }],
              retrieval: { status: "unavailable", attemptedAt: 2, reason: "全文来源服务器暂时异常，请稍后重试。" },
            },
          ],
        }),
      ),
    )
    const source = host.querySelector(".mat-source")!
    expect(source.querySelector(".mat-type")?.textContent).toBe("部分正文")
    expect(source.textContent).not.toContain("当前仅有摘要")
    expect(source.textContent).toContain("全文来源服务器暂时异常")
    expect(source.querySelector("pre")?.textContent).toContain("Useful partial text remains available")
  })
  test("does not expose unsafe or credential-bearing source links", () => {
    const value: MaterialProject = {
      ...project(),
      sources: [
        {
          id: "paper",
          title: "Source with unsafe links",
          authors: "",
          origin: "openalex",
          createdAt: 1,
          kind: "partial",
          text: "Original text remains available for checking.",
          url: "javascript:alert(1)",
          retrieval: { status: "partial", attemptedAt: 1, url: "https://user:secret@papers.example.org/result.pdf" },
        },
      ],
    }
    const sources = mount(() => subject.Sources(props(value)))
    const evidence = mount(() =>
      subject.Evidence({
        project: value,
        t,
        evidence: { sourceID: "paper", quote: "Original text remains available" },
      }),
    )
    expect(sources.querySelector(".mat-source a")).toBeNull()
    expect(evidence.querySelector("a")).toBeNull()
  })
  test("renders an inline research record and safely retries cancellation with a fresh revision", async () => {
    let current: MaterialProject = {
      ...project(),
      id: "mat_00000000000000000000000000000001",
      status: "running",
      stages: [{ key: "intake", status: "running" }],
    }
    const bodies: unknown[] = []
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/library"))
        return Response.json({ materialsProjectID: current.id, status: "unbound", files: [], warnings: [] })
      if (String(url).endsWith("/activity"))
        return Response.json({
          projectID: current.id,
          revision: current.revision,
          status: current.status,
          serverTime: Date.now(),
          events: [],
        })
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        if (bodies.length === 1) {
          current = { ...current, revision: 2 }
          return new Response(JSON.stringify({ error: "课题已更新，请刷新后重试" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          })
        }
        current = { ...current, revision: 3, status: "cancelled" }
      }
      return new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    const host = mount(() =>
      card.MaterialSessionCard({
        projectID: current.id,
        t,
        locale: "zh",
        request: (path, init) => api.settingsApi("http://test.invalid", fetcher, path, init),
      }),
    )
    await flush()
    expect(host.querySelector(".mat-session")?.getAttribute("aria-label")).toBe("材料科研记录")
    expect(host.querySelector("aside")).toBeNull()
    expect(host.querySelector("form")).toBeNull()
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "停止任务")!
      .click()
    await flush()
    await flush()
    expect(bodies).toEqual([
      { action: "cancel", revision: 1 },
      { action: "cancel", revision: 2 },
    ])
    expect(host.querySelector(".mat-session-header .mat-badge")?.textContent).toBe("已取消")
    const tab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (button) => button.textContent === "文献与证据",
    )!
    tab.click()
    expect(tab.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector('input[type="file"]')?.getAttribute("accept")).toContain(".pdf")
  })
  test("aborts a pending research request when its conversation card is removed", async () => {
    let signal: AbortSignal | undefined
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = web.render(
      () =>
        card.MaterialSessionCard({
          projectID: "mat_00000000000000000000000000000002",
          t,
          locale: "zh",
          request: (_path, init) => {
            signal = init?.signal ?? undefined
            return new Promise((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
            )
          },
        }),
      host,
    )
    await flush()
    expect(signal?.aborted).toBe(false)
    dispose()
    expect(signal?.aborted).toBe(true)
    await flush()
  })
  test("keeps clarification input during project polling and submits the answer", async () => {
    const [store, setStore] = solidStore.createStore({ project: project() })
    const decisions: unknown[] = []
    const base = props(store.project, {
      action: async (value) => {
        decisions.push(value)
        return true
      },
    })
    const host = mount(() =>
      subject.Overview({
        ...base,
        get project() {
          return store.project
        },
      }),
    )
    const input = host.querySelector("textarea")!
    input.value = "77 K and 1 T"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    setStore("project", {
      ...project(),
      revision: 2,
      events: [{ id: "event1", kind: "info", message: "Updated", createdAt: 2 }],
    })
    expect(host.querySelector("textarea")?.value).toBe("77 K and 1 T")
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await flush()
    expect(decisions).toEqual([{ action: "answer", answers: "77 K and 1 T" }])
    expect(host.querySelector("textarea")?.value).toBe("")
  })
  test("requires human confirmation and sends the exact protocol artifact ID", async () => {
    const decisions: unknown[] = []
    const host = mount(() =>
      subject.Protocol(
        props(protocolProject(), {
          action: async (value) => {
            decisions.push(value)
            return true
          },
        }),
      ),
    )
    const button = host.querySelector("button")!
    expect(button.disabled).toBe(true)
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event("change", { bubbles: true }))
    expect(button.disabled).toBe(false)
    button.click()
    await flush()
    expect(decisions).toEqual([{ action: "approve_protocol", protocolID: "protocol1" }])
  })
  test.each(["awaiting_approval", "completed"] as const)(
    "allows manual continuation from accepted ideas (%s)",
    async (status) => {
      const idea = {
        id: "accepted",
        title: "Accepted idea",
        hypothesis: "H",
        design: "D",
        mechanism: "M",
        strategyIDs: ["node"],
        evidence: [{ sourceID: "paper", quote: "A sufficiently long evidence quote" }],
        novelty: "N",
        feasibility: "F",
        risks: [],
        validation: "V",
        status: "inferred_design",
        review: { decision: "accept", rationale: "Evidence consistent", issues: [] },
        rank: 1,
      }
      const value: MaterialProject = {
        ...project(),
        status,
        target: status === "completed" ? "ideas" : "protocol",
        artifacts: [
          {
            id: "ideas1",
            stage: "ideas" as const,
            title: "Ideas",
            version: 1,
            createdAt: 1,
            markdown: "",
            data: {
              ideas: [idea, { ...idea, id: "rejected", rank: 2, review: { ...idea.review, decision: "reject" } }],
              comparison: "Comparison",
            },
            inputArtifactIDs: [],
          },
        ],
      }
      const [store, setStore] = solidStore.createStore({ project: value })
      const decisions: unknown[] = []
      const base = props(value, {
        action: async (value) => {
          decisions.push(value)
          return true
        },
      })
      const host = mount(() =>
        subject.Ideas({
          ...base,
          get project() {
            return store.project
          },
        }),
      )
      const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      expect(boxes.length).toBe(2)
      expect(boxes[0].disabled).toBe(false)
      expect(boxes[1].disabled).toBe(true)
      const continueButton = host.querySelector<HTMLButtonElement>(".mat-action-bar button")!
      expect(continueButton.disabled).toBe(true)
      expect(decisions).toEqual([])
      boxes[0].checked = true
      boxes[0].dispatchEvent(new Event("change", { bubbles: true }))
      setStore("project", "revision", 2)
      expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
      expect(continueButton.disabled).toBe(false)
      continueButton.click()
      await flush()
      expect(decisions).toEqual([{ action: "select_ideas", ideaIDs: ["accepted"] }])
      setStore("project", "artifacts", (artifacts) => [...artifacts, ...protocolProject().artifacts])
      expect(host.querySelector('input[type="checkbox"]')).toBeNull()
      expect(host.querySelector(".mat-action-bar")).toBeNull()
      expect(decisions).toEqual([{ action: "select_ideas", ideaIDs: ["accepted"] }])
    },
  )
  test("submits a natural-language protocol revision and hides editing after approval", async () => {
    const decisions: unknown[] = []
    const [store, setStore] = solidStore.createStore({ project: protocolProject() })
    const base = props(store.project, {
      action: async (value) => {
        decisions.push(value)
        return true
      },
    })
    const host = mount(() =>
      subject.Protocol({
        ...base,
        get project() {
          return store.project
        },
      }),
    )
    const textarea = host.querySelector<HTMLTextAreaElement>(".mat-revise textarea")!
    textarea.value = "Add three replicates and measure at 77 K, 1 T."
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    host.querySelector(".mat-revise form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await flush()
    expect(decisions).toEqual([
      { action: "revise_protocol", answers: "Add three replicates and measure at 77 K, 1 T." },
    ])
    setStore("project", { ...protocolProject(), status: "awaiting_data", approvedProtocolID: "protocol1" })
    expect(host.querySelector(".mat-revise")).toBeNull()
  })
  test("blocks CSV data that references an unapproved experimental group", async () => {
    const value = { ...protocolProject(), status: "awaiting_data" as const, approvedProtocolID: "protocol1" }
    const batches: unknown[] = []
    const host = mount(() =>
      subject.Analysis(
        props(value, {
          saveBatch: async (value) => {
            batches.push(value)
            return true
          },
        }),
      ),
    )
    const input = host.querySelector<HTMLInputElement>('input:not([type="file"])')!
    input.value = "Batch 1"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const csv = host.querySelector("textarea")!
    csv.value = "sampleID,groupID,property,value,unit,temperatureK,fieldT,angleDeg\nS1,unknown,Jc,100,A/cm2,77,1,0"
    csv.dispatchEvent(new Event("input", { bubbles: true }))
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await flush()
    expect(batches).toEqual([])
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("groupID")
    csv.value = csv.value.replace("unknown", "control")
    csv.dispatchEvent(new Event("input", { bubbles: true }))
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await flush()
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      protocolID: "protocol1",
      name: "Batch 1",
      measurements: [{ sampleID: "S1", groupID: "control", value: 100, temperatureK: 77, fieldT: 1, angleDeg: 0 }],
    })
  })
})

function chooseSource(host: HTMLElement, file: File) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, "files", { configurable: true, value: [file] })
  input.dispatchEvent(new Event("change", { bubbles: true }))
}
function editSource(host: HTMLElement, text: string) {
  const area = host.querySelector("textarea")!
  area.value = text
  area.dispatchEvent(new Event("input", { bubbles: true }))
}
function submitSource(host: HTMLElement) {
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
}

test("source uploads retain original bytes when extracted text is edited and clear originals after saving", async () => {
  const original = new File(["Original REBCO scientific source material."], "paper.txt", { type: "text/plain" })
  const saves: Array<{ value: Record<string, unknown>; file?: File }> = []
  const host = mount(() =>
    subject.Sources(
      props(project(), {
        saveSource: async (value, file) => {
          saves.push({ value, file })
          return saves.length > 1
        },
      }),
    ),
  )
  chooseSource(host, original)
  await flush()
  expect(host.textContent).toContain("随资料保存原件")
  editSource(host, "Corrected REBCO scientific source material.")
  submitSource(host)
  await flush()
  expect(saves[0]!.value.text).toBe("Corrected REBCO scientific source material.")
  expect(await saves[0]!.file!.text()).toBe("Original REBCO scientific source material.")
  expect(host.textContent).toContain("随资料保存原件")
  submitSource(host)
  await flush()
  expect(saves[1]!.file?.name).toBe("paper.txt")
  expect(host.textContent).not.toContain("随资料保存原件")
})

test("removing or unsuccessfully replacing an original never submits the previous file", async () => {
  const saves: (File | undefined)[] = []
  const host = mount(() =>
    subject.Sources(
      props(project(), {
        saveSource: async (_value, file) => {
          saves.push(file)
          return true
        },
      }),
    ),
  )
  chooseSource(host, new File(["Original REBCO scientific source material."], "paper.txt"))
  await flush()
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "移除原件")!
    .click()
  submitSource(host)
  await flush()
  expect(saves).toEqual([undefined])
  chooseSource(host, new File(["Another REBCO scientific source material."], "next.txt"))
  await flush()
  chooseSource(host, new File(["Invalid"], "replacement.exe"))
  await flush()
  expect(host.textContent).not.toContain("随资料保存原件")
  editSource(host, "Pasted replacement with enough scientific material.")
  submitSource(host)
  await flush()
  expect(saves).toEqual([undefined, undefined])
})

test("request transport preserves multipart original and metadata without overriding the browser boundary", async () => {
  const calls: RequestInit[] = []
  const request = files.materialRequest(async (_path, init) => {
    calls.push(init!)
    return Response.json({ ok: true })
  })
  const form = new FormData()
  form.append("file", new File(["original"], "paper.pdf", { type: "application/pdf" }))
  form.append("source", JSON.stringify({ title: "Paper", text: "Corrected text" }))
  await request("/sources/upload", { method: "POST", headers: { "content-type": "application/json" }, body: form })
  expect(new Headers(calls[0]!.headers).has("content-type")).toBe(false)
  expect((calls[0]!.body as FormData).get("source")).toBe(form.get("source"))
  expect(await ((calls[0]!.body as FormData).get("file") as File).text()).toBe("original")
  await request("/sources", { method: "POST", body: JSON.stringify({ text: "Pasted" }) })
  expect(new Headers(calls[1]!.headers).get("content-type")).toBe("application/json")
})

test("conversation source form routes originals to multipart upload and pasted text to the JSON source endpoint", async () => {
  const current = project()
  const mutations: Array<{ path: string; init: RequestInit }> = []
  const host = mount(() =>
    card.MaterialSessionCard({
      projectID: current.id,
      t,
      locale: "zh",
      request: (async (path: string, init?: RequestInit) => {
        if (path.endsWith("/library"))
          return { materialsProjectID: current.id, status: "unbound", files: [], warnings: [] }
        if (path.endsWith("/activity")) throw new api.SettingsApiError("Legacy", 404)
        if (init?.method === "POST") mutations.push({ path, init })
        return current
      }) as import("./session-card").MaterialRequest,
    }),
  )
  await flush()
  host.querySelector<HTMLButtonElement>('[role="tab"][id$="-literature"]')!.click()
  chooseSource(host, new File(["Original REBCO scientific source material."], "original.txt"))
  await flush()
  editSource(host, "Corrected REBCO scientific source material.")
  submitSource(host)
  await flush()
  expect(mutations[0]!.path).toEndWith("/sources/upload")
  const body = mutations[0]!.init.body as FormData
  expect((body.get("file") as File).name).toBe("original.txt")
  expect(await (body.get("file") as File).text()).toBe("Original REBCO scientific source material.")
  expect(JSON.parse(body.get("source") as string).text).toBe("Corrected REBCO scientific source material.")
  const title = host.querySelector<HTMLInputElement>("input[required]")!
  title.value = "Pasted source"
  title.dispatchEvent(new Event("input", { bubbles: true }))
  editSource(host, "Pasted REBCO source with sufficient text.")
  submitSource(host)
  await flush()
  expect(mutations[1]!.path).toEndWith("/sources")
  expect(typeof mutations[1]!.init.body).toBe("string")
  expect(JSON.parse(mutations[1]!.init.body as string).title).toBe("Pasted source")
})
