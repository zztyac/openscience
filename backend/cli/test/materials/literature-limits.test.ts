import { expect, test } from "bun:test"
import type { MaterialActivityUpdate } from "@synsci/util/materials"
import { collectLiterature, sourceFromHit } from "../../src/materials/literature"
import { createMaterialExecutor, materialRequestBudget } from "../../src/materials/pipeline"
import { Network } from "../../src/settings/network"
import { HttpStatusError, SourceResponseError } from "../../src/science/connectors/http"
import { ideaProjectFixture, intakeFixture } from "./pipeline-fixtures"

const abstract = "REBCO superconducting thin films exhibit field dependent critical current density."
const privateDetail = "https://private-fixture.test/?api_key=secret-fixture-value Authorization: secret-header-fixture"

function literatureProject(queries = ["REBCO films pinning"]) {
  const project = ideaProjectFixture()
  project.sources = []
  project.artifacts = [
    {
      id: "intake-fixture",
      stage: "intake",
      version: 1,
      title: "Fixture intake",
      createdAt: 1,
      markdown: "",
      inputArtifactIDs: [],
      data: { ...intakeFixture(project), searchQueries: queries },
    },
  ]
  return project
}

test("literature reports search and fulltext work before it finishes without exposing source contents", async () => {
  const reports: MaterialActivityUpdate[] = []
  const result = await collectLiterature(
    literatureProject(),
    new AbortController().signal,
    [
      {
        id: "crossref",
        search: async () => {
          expect(reports.at(-1)).toMatchObject({ phase: "searching", role: "literature-search" })
          expect(reports.at(-1)?.item).toContain("Crossref")
          return [{ id: "paper", title: "REBCO evidence", extra: { DOI: "10.1234/fixture", abstract } }]
        },
      },
    ],
    async (source) => {
      expect(reports.at(-1)).toMatchObject({ phase: "retrieving", completed: 0, total: 1, item: source.title })
      return { ...source, retrieval: { status: "unavailable", attemptedAt: 1, reason: privateDetail } }
    },
    (update) => reports.push(update),
  )
  expect(result.sources).toHaveLength(1)
  expect(reports).toContainEqual({
    phase: "retrieving",
    role: "fulltext-retrieval",
    completed: 1,
    total: 1,
    item: "REBCO evidence",
  })
  expect(reports.at(-1)).toEqual({ phase: "validating", role: "evidence-preparation" })
  expect(JSON.stringify(reports)).not.toContain(abstract)
  expect(JSON.stringify(reports)).not.toContain("secret-")
})

for (const [name, error, expected] of [
  ["policy", new Network.PolicyError(privateDetail), "网络策略拦截"],
  ["DNS timeout", new Network.ResolutionError("DNS_TIMEOUT", { cause: new Error(privateDetail) }), "DNS 解析超时"],
  [
    "DNS failure",
    new Network.ResolutionError("DNS_LOOKUP_FAILED", { cause: new Error(privateDetail) }),
    "DNS 解析失败",
  ],
  ["no DNS addresses", new Network.ResolutionError("DNS_NO_ADDRESSES"), "DNS 解析失败"],
  ["unauthorized", new HttpStatusError(401, privateDetail), "身份验证失败（HTTP 401）"],
  ["forbidden", new HttpStatusError(403, privateDetail), "拒绝访问（HTTP 403）"],
  ["rate limited", new HttpStatusError(429, privateDetail, { retryAfterMs: 120_000 }), "至少等待 120 秒"],
  ["upstream timeout", new HttpStatusError(408, privateDetail), "请求超时（HTTP 408）"],
  ["server error", new HttpStatusError(503, privateDetail), "服务器暂时异常（HTTP 503）"],
  ["rejected request", new HttpStatusError(400, privateDetail), "未能处理检索请求"],
  ["HTML or API failure", new SourceResponseError(privateDetail), "返回了异常内容"],
  ["invalid JSON", new SyntaxError(privateDetail), "不是有效 JSON"],
  ["request timeout", new DOMException(privateDetail, "TimeoutError"), "请求超时"],
  ["connection timeout", Object.assign(new Error(privateDetail), { code: "ETIMEDOUT" }), "连接超时"],
  ["connection reset", Object.assign(new Error(privateDetail), { code: "ECONNRESET" }), "无法连接来源服务"],
  ["TLS failure", Object.assign(new Error(privateDetail), { code: "CERT_HAS_EXPIRED" }), "安全连接校验失败"],
  ["unknown", new Error(privateDetail), "来源暂时不可用"],
] as const) {
  test(`literature reports a safe actionable reason for ${name}`, async () => {
    const result = await collectLiterature(literatureProject(), new AbortController().signal, [
      { id: "openalex", search: async () => Promise.reject(error) },
    ])
    expect(result.sources).toHaveLength(0)
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toContain(expected)
    expect(result.gaps[0]).not.toContain("private-fixture")
    expect(result.gaps[0]).not.toContain("secret-")
    expect(result.gaps[0]).not.toContain("Authorization")
  })
}

for (const [cause, expected] of [
  [new DOMException(privateDetail, "TimeoutError"), "DNS 解析超时"],
  [Object.assign(new Error(privateDetail), { code: "ENOTFOUND" }), "DNS 解析失败"],
] as const) {
  test(`DNS errors retain their safe classification across Network and material collection: ${cause.name}`, async () => {
    let connections = 0
    const result = await collectLiterature(literatureProject(), new AbortController().signal, [
      {
        id: "openalex",
        search: async (_query, options) => {
          await Network.fetch(
            "https://api.openalex.org/works",
            { signal: options?.signal },
            {
              resolveAddresses: async () => Promise.reject(cause),
              transport: async () => {
                connections++
                return Response.json({ results: [] })
              },
            },
          )
          return []
        },
      },
    ])
    expect(connections).toBe(0)
    expect(result.gaps[0]).toContain(expected)
    expect(result.gaps[0]).not.toContain("private-fixture")
    expect(result.gaps[0]).not.toContain("secret-")
  })
}

for (const status of [401, 403, 429]) {
  test(`an HTTP ${status} source is not re-queried while the other source continues`, async () => {
    const calls = { openalex: 0, crossref: 0 }
    const result = await collectLiterature(
      literatureProject(["REBCO films pinning", "REBCO films grain boundaries"]),
      new AbortController().signal,
      [
        {
          id: "openalex",
          search: async () => {
            calls.openalex++
            throw new HttpStatusError(status, privateDetail, { retryAfterMs: 120_000 })
          },
        },
        {
          id: "crossref",
          search: async () => [
            { id: `paper-${++calls.crossref}`, title: "A real abstract fixture", extra: { abstract } },
          ],
        },
      ],
    )
    expect(calls).toEqual({ openalex: 1, crossref: 2 })
    expect(result.sources).toHaveLength(2)
    expect(result.gaps.filter((gap) => gap.startsWith("OpenAlex："))).toHaveLength(1)
    expect(result.gaps.join(" ")).not.toContain("secret-")
  })
}

test("a transient source failure does not disable the next query", async () => {
  let calls = 0
  const result = await collectLiterature(
    literatureProject(["REBCO films pinning", "REBCO films grain boundaries"]),
    new AbortController().signal,
    [
      {
        id: "crossref",
        search: async () => {
          if (++calls === 1) throw new HttpStatusError(503, privateDetail)
          return [{ id: "recovered", title: "Recovered abstract", extra: { abstract } }]
        },
      },
    ],
  )
  expect(calls).toBe(2)
  expect(result.sources.map((source) => source.title)).toEqual(["Recovered abstract"])
})

test("cancellation still rejects when uploaded full texts would skip search", async () => {
  const controller = new AbortController()
  const reason = new Error("fixture user cancellation")
  controller.abort(reason)
  await expect(collectLiterature(ideaProjectFixture(), controller.signal, [])).rejects.toBe(reason)
})

for (const outcome of ["reject", "resolve"]) {
  test(`cancellation is never converted to a source gap when a connector ${outcome}s`, async () => {
    const controller = new AbortController()
    const reason = new Error("fixture user cancellation")
    let calls = 0
    await expect(
      collectLiterature(literatureProject(["REBCO films pinning", "REBCO films grain boundaries"]), controller.signal, [
        {
          id: "crossref",
          search: async () => {
            calls++
            controller.abort(reason)
            if (outcome === "reject") throw new Error("late source failure")
            return [{ id: "late", title: "Late result", extra: { abstract } }]
          },
        },
      ]),
    ).rejects.toBe(reason)
    expect(calls).toBe(1)
  })
}

test("one malformed upstream record cannot discard other useful literature", async () => {
  const project = ideaProjectFixture()
  project.sources = []
  const result = await collectLiterature(project, new AbortController().signal, [
    {
      id: "crossref",
      search: async () => [
        { id: "bad", title: "Invalid publication year", extra: { abstract, issued: { "date-parts": [[2025.5]] } } },
        { id: "good", title: "A valid abstract", extra: { abstract } },
      ],
    },
  ])
  expect(result.sources.map((source) => source.title)).toEqual(["A valid abstract"])
  const many = sourceFromHit(
    {
      id: "many-authors",
      title: "Large collaboration",
      extra: { abstract, author: Array.from({ length: 300 }, () => ({ name: "Long scientific author name" })) },
    },
    "crossref",
  )
  expect(many?.kind).toBe("abstract")
  expect(many?.authors.length).toBeLessThanOrEqual(2000)
  const source = sourceFromHit(
    { id: "unsafe", title: "Paper", url: "file:///private/secret", extra: { abstract } },
    "crossref",
  )
  expect(source?.url).toBeUndefined()
})

test("automatic abstracts respect remaining project text capacity without rejecting uploaded sources", async () => {
  const project = ideaProjectFixture()
  project.sources = Array.from({ length: 5 }, (_, index) => ({
    id: `uploaded-${index}`,
    title: `Paper ${index}`,
    authors: "",
    text: "x".repeat(index === 4 ? 190_000 : 200_000),
    kind: "note" as const,
    origin: "upload" as const,
    createdAt: 1,
  }))
  const result = await collectLiterature(project, new AbortController().signal, [
    {
      id: "crossref",
      search: async () => [
        { id: "too-large", title: "Beyond the remaining budget", extra: { abstract: "evidence ".repeat(3000) } },
        { id: "fits", title: "Fits the remaining budget", extra: { abstract } },
      ],
    },
  ])
  expect(result.sources).toHaveLength(6)
  expect(result.sources.at(-1)?.title).toBe("Fits the remaining budget")
  expect(result.sources.reduce((sum, source) => sum + source.text.length, 0)).toBeLessThanOrEqual(1_000_000)
  expect(result.gaps.some((gap) => gap.includes("正文总长度"))).toBe(true)
})

test("metadata-only hits become evidence only after real body text is acquired", async () => {
  const result = await collectLiterature(
    literatureProject(),
    new AbortController().signal,
    [
      {
        id: "crossref",
        search: async () => [
          { id: "body", title: "Full body without abstract", extra: { DOI: "10.1234/body" } },
          { id: "missing", title: "Metadata is not evidence", summary: abstract, extra: { DOI: "10.1234/missing" } },
        ],
      },
    ],
    async (source) =>
      source.doi === "10.1234/body"
        ? {
            ...source,
            kind: "fulltext",
            text: abstract,
            chunks: [{ id: "chunk-body", page: 1, text: abstract }],
            retrieval: { status: "fulltext", attemptedAt: 1, pageCount: 1 },
          }
        : { ...source, retrieval: { status: "unavailable", attemptedAt: 1, reason: "未找到开放全文" } },
  )
  expect(result.sources).toHaveLength(1)
  expect(result.sources[0].kind).toBe("fulltext")
  expect(result.sources[0].chunks?.[0].text).toBe(abstract)
  expect(result.gaps.some((gap) => gap.includes("Metadata is not evidence") && gap.includes("未加入证据库"))).toBe(true)
})

test("fulltext enrichment is bounded, preserves uploads, and upgrades existing IDs", async () => {
  const project = literatureProject()
  project.sources = [
    {
      id: "upload",
      title: "User data",
      authors: "",
      kind: "note",
      origin: "upload",
      createdAt: 1,
      text: "x".repeat(200_000),
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `auto-${index}`,
      title: `Paper ${index}`,
      authors: "",
      kind: "abstract" as const,
      origin: "crossref" as const,
      createdAt: 1,
      text: abstract,
    })),
  ]
  let active = 0
  let maximum = 0
  let searches = 0
  const result = await collectLiterature(
    project,
    new AbortController().signal,
    [
      {
        id: "crossref",
        search: async () => {
          searches++
          return []
        },
      },
    ],
    async (source, options) => {
      maximum = Math.max(maximum, ++active)
      await Bun.sleep(1)
      active--
      return {
        ...source,
        kind: "partial",
        text: "x".repeat(options.maxChars!),
        retrieval: { status: "partial", attemptedAt: 1, reason: "正文被截断" },
      }
    },
  )
  expect(searches).toBe(0)
  expect(maximum).toBe(2)
  expect(result.sources[0]).toEqual(project.sources[0])
  expect(result.sources.map((source) => source.id)).toEqual(project.sources.map((source) => source.id))
  expect(result.sources.reduce((sum, source) => sum + source.text.length, 0)).toBeLessThanOrEqual(1_000_000)
  expect(result.gaps.filter((gap) => gap.includes("仅取得部分正文"))).toHaveLength(12)
  expect(project.sources[1].kind).toBe("abstract")
})

test("a metadata-only duplicate cannot hide another source's real abstract", async () => {
  const result = await collectLiterature(
    literatureProject(),
    new AbortController().signal,
    [
      {
        id: "openalex",
        search: async () => [{ id: "W123", title: "Same paper", extra: { doi: "https://doi.org/10.1234/shared" } }],
      },
      {
        id: "crossref",
        search: async () => [{ id: "10.1234/shared", title: "Same paper", extra: { DOI: "10.1234/shared", abstract } }],
      },
    ],
    async (source) => ({ ...source, retrieval: { status: "unavailable", attemptedAt: 1, reason: "未找到开放全文" } }),
  )
  expect(result.sources).toHaveLength(1)
  expect(result.sources[0].text).toBe(abstract)
  expect(result.sources[0].origin).toBe("crossref")
})

test("unused shares from unavailable papers expand cached text without another download", async () => {
  const project = literatureProject()
  project.sources = Array.from({ length: 12 }, (_, index) => ({
    id: `auto-${index}`,
    title: `Paper ${index}`,
    authors: "",
    kind: "abstract" as const,
    origin: "crossref" as const,
    createdAt: 1,
    text: abstract,
  }))
  const attempts: boolean[] = []
  const result = await collectLiterature(project, new AbortController().signal, [], async (source, options) => {
    attempts.push(!!options.cacheOnly)
    if (source.id !== "auto-0") return source
    const text = "x".repeat(Math.min(110_000, options.maxChars!))
    return { ...source, text, kind: text.length < 110_000 ? "partial" : "fulltext" }
  })
  expect(attempts.filter(Boolean)).toHaveLength(1)
  expect(attempts.filter((cached) => !cached)).toHaveLength(12)
  expect(result.sources[0].kind).toBe("fulltext")
  expect(result.sources[0].text).toHaveLength(110_000)
  expect(result.sources.reduce((sum, source) => sum + source.text.length, 0)).toBeLessThanOrEqual(1_000_000)
})

test("cancellation during fulltext retrieval stops collection without publishing a partial stage", async () => {
  const controller = new AbortController()
  const reason = new Error("user cancelled fulltext")
  await expect(
    collectLiterature(
      literatureProject(),
      controller.signal,
      [{ id: "crossref", search: async () => [{ id: "paper", title: "Paper", extra: { abstract } }] }],
      async (source) => {
        controller.abort(reason)
        return source
      },
    ),
  ).rejects.toBe(reason)
})

test("a failed literature stage explains network policy blocks without echoing sensitive errors", async () => {
  const project = ideaProjectFixture()
  project.sources = []
  const executor = createMaterialExecutor({
    skills: false,
    search: (project, signal) =>
      collectLiterature(project, signal, [
        {
          id: "openalex",
          search: async () => {
            throw new Network.PolicyError("api_key=secret-fixture-value")
          },
        },
      ]),
  })
  const error = await executor(project, "literature", new AbortController().signal).catch((error: Error) => error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("代理 DNS")
  expect((error as Error).message).not.toContain("secret-fixture-value")
})

test("the assembled request budget bounds model context and appended repair/review text", () => {
  expect(materialRequestBudget("研究 REBCO 薄膜", { context: 128_000, output: 32_000 })).toEqual({
    maxOutputTokens: 12_000,
  })
  expect(materialRequestBudget("REBCO", { context: 8_192, output: 8_192 })).toEqual({ maxOutputTokens: 4_096 })
  expect(() => materialRequestBudget("测量".repeat(10_000), { context: 16_000, output: 4_000 })).toThrow("输入范围")
  expect(() => materialRequestBudget("x".repeat(400_001), { context: 1_000_000, output: 32_000 })).toThrow("输入范围")
})
