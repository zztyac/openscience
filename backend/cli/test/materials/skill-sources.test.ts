import { afterEach, beforeEach, expect, test } from "bun:test"
import { clearCache, resetRateLimits, withHttpTestPolicy, type HttpTestPolicy } from "../../src/science/connectors/http"
import { lookupSkillPaper, searchSkillPapers, skillAvailability } from "../../src/materials/skill-sources"

const signal = () => new AbortController().signal
const original = {
  exa: process.env.EXA_API_KEY,
  deepxiv: process.env.DEEPXIV_API_KEY,
  token: process.env.DEEPXIV_TOKEN,
}
beforeEach(() => {
  clearCache()
  resetRateLimits()
})
afterEach(() => {
  for (const [name, value] of [
    ["EXA_API_KEY", original.exa],
    ["DEEPXIV_API_KEY", original.deepxiv],
    ["DEEPXIV_TOKEN", original.token],
  ]) {
    if (value === undefined) delete process.env[name!]
    else process.env[name!] = value
  }
})
function transport<T>(handler: HttpTestPolicy["transport"], action: () => T): T {
  return withHttpTestPolicy({ resolveAddresses: async () => ["93.184.216.34"], transport: handler }, action)
}
const abstract = "We measured critical current density in REBCO films containing artificial pinning defects."
const s2 = {
  paperId: "paper-1",
  title: "Pinning in REBCO",
  abstract,
  year: 2024,
  venue: "Superconductivity",
  authors: [{ name: "A. Researcher" }],
  externalIds: { DOI: "10.1234/pinning", ArXiv: "2401.12345" },
  openAccessPdf: { url: "https://repository.example.org/pinning.pdf" },
}
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://arxiv.org/abs/2401.12345v1</id><title>Pinning in REBCO</title><summary>${abstract}</summary><published>2024-01-01T00:00:00Z</published><author><name>A. Researcher</name></author><link title="pdf" href="https://arxiv.org/pdf/2401.12345v1" /></entry></feed>`

test("arxiv retains original abstract, identifiers and PDF location", async () => {
  await transport(
    async () => new Response(atom),
    async () => {
      const hits = await searchSkillPapers({ skill: "arxiv", query: "REBCO", signal: signal() })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.extra).toMatchObject({
        materialSkill: "arxiv",
        materialPaper: {
          arxiv: "2401.12345v1",
          abstract,
          authors: "A. Researcher",
          year: 2024,
          pdfURLs: ["https://arxiv.org/pdf/2401.12345v1"],
        },
      })
    },
  )
})

for (const [query, expected] of [
  ["REBCO flux pinning", "all:REBCO AND all:flux AND all:pinning"],
  ['REBCO "flux pinning"', 'all:REBCO AND all:"flux pinning"'],
  ['"thin film" "critical current"', 'all:"thin film" AND all:"critical current"'],
  ["ti:REBCO AND abs:pinning", "ti:REBCO AND abs:pinning"],
  ["all:REBCO OR all:YBCO", "all:REBCO OR all:YBCO"],
  ["REBCO OR YBCO", "all:REBCO OR YBCO"],
  ["cat:cond-mat.supr-con AND all:REBCO", "cat:cond-mat.supr-con AND all:REBCO"],
  ['REBCO "AND OR"', 'all:REBCO AND all:"AND OR"'],
]) {
  test(`arxiv sends deliberate keyword semantics for ${query}`, async () => {
    const requests: string[] = []
    await transport(
      async (url) => {
        requests.push(url.searchParams.get("search_query") ?? "")
        return new Response(atom)
      },
      () => searchSkillPapers({ skill: "arxiv", query: query!, signal: signal() }),
    )
    expect(requests).toEqual([expected!])
  })
}

test("arxiv rejects unmatched phrase quotes before querying a source", async () => {
  let calls = 0
  await transport(
    async () => {
      calls++
      return new Response(atom)
    },
    async () => {
      await expect(
        searchSkillPapers({ skill: "arxiv", query: 'REBCO "flux pinning', signal: signal() }),
      ).rejects.toThrow("引号未配对")
    },
  )
  expect(calls).toBe(0)
})

test("openalex reconstructs the actual abstract and retains all open locations", async () => {
  await transport(
    async () =>
      Response.json({
        results: [
          {
            id: "https://openalex.org/W123",
            display_name: "REBCO results",
            doi: "https://doi.org/10.1234/film",
            abstract_inverted_index: { REBCO: [0], films: [1] },
            publication_year: 2025,
            authorships: [{ author: { display_name: "B. Author" } }],
            primary_location: { pdf_url: "https://publisher.example.org/article.pdf" },
            best_oa_location: { pdf_url: "https://repository.example.org/copy.pdf" },
          },
        ],
      }),
    async () => {
      const hits = await searchSkillPapers({ skill: "openalex", query: "REBCO", signal: signal() })
      expect(hits[0]?.extra?.materialPaper).toEqual({
        doi: "10.1234/film",
        arxiv: undefined,
        abstract: "REBCO films",
        authors: "B. Author",
        year: 2025,
        pdfURLs: ["https://publisher.example.org/article.pdf", "https://repository.example.org/copy.pdf"],
      })
    },
  )
})

test("semantic-scholar requests and returns openAccessPdf with exact query escaping", async () => {
  await transport(
    async (url) => {
      expect(url.searchParams.get("query")).toBe("REBCO & BZO / 77 K")
      expect(url.searchParams.get("fields")).toContain("openAccessPdf")
      return Response.json({ data: [s2] })
    },
    async () => {
      const hits = await searchSkillPapers({ skill: "semantic-scholar", query: "REBCO & BZO / 77 K", signal: signal() })
      expect(hits[0]?.extra?.materialPaper).toMatchObject({
        doi: "10.1234/pinning",
        arxiv: "2401.12345",
        abstract,
        pdfURLs: ["https://repository.example.org/pinning.pdf", "https://arxiv.org/pdf/2401.12345"],
      })
    },
  )
})

test("exact DOI lookup does not mistake title search results for the requested paper", async () => {
  await transport(
    async (url) => {
      expect(decodeURIComponent(url.pathname)).toBe("/graph/v1/paper/DOI:10.1234/pinning")
      return Response.json(s2)
    },
    async () => {
      const hit = await lookupSkillPaper({
        skill: "semantic-scholar",
        reference: "https://doi.org/10.1234/pinning",
        signal: signal(),
      })
      expect(hit?.extra?.materialPaper).toMatchObject({ doi: "10.1234/pinning", abstract })
    },
  )
})

test("missing exact lookup is distinct from upstream failures", async () => {
  await transport(
    async () => new Response("missing", { status: 404 }),
    async () => {
      expect(
        await lookupSkillPaper({ skill: "openalex", reference: "10.1234/missing", signal: signal() }),
      ).toBeUndefined()
    },
  )
  await transport(
    async () => new Response("denied", { status: 401 }),
    async () => {
      await expect(
        lookupSkillPaper({ skill: "semantic-scholar", reference: "10.1234/denied", signal: signal() }),
      ).rejects.toThrow()
    },
  )
})

test("Exa uses configured credentials and treats generated text as discovery only", async () => {
  process.env.EXA_API_KEY = "exa-fixture-key"
  await transport(
    async (url, init) => {
      expect(url.hostname).toBe("api.exa.ai")
      expect(new Headers(init.headers).get("x-api-key")).toBe("exa-fixture-key")
      expect(JSON.parse(String(init.body))).toMatchObject({ category: "research paper", numResults: 3 })
      return Response.json({
        results: [
          {
            title: "A paper",
            url: "https://arxiv.org/abs/2401.12345",
            text: "Extracted webpage",
            summary: "Generated abstract",
            highlights: ["Generated highlight"],
            abstract: "Not an original abstract field",
            publishedDate: "2024-01-01",
          },
          { title: "Unsafe URL", url: "file:///etc/passwd" },
        ],
      })
    },
    async () => {
      const hits = await searchSkillPapers({ skill: "exa-search", query: "REBCO", limit: 3, signal: signal() })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.summary).toBeUndefined()
      expect(hits[0]?.extra?.materialPaper).toMatchObject({ arxiv: "2401.12345", abstract: undefined })
      expect(JSON.stringify(hits)).not.toContain("Generated")
    },
  )
})

test("DeepXiv uses authenticated retrieval and never promotes TLDR to an abstract", async () => {
  process.env.DEEPXIV_API_KEY = "deepxiv-fixture-key"
  await transport(
    async (url, init) => {
      expect(url.hostname).toBe("data.rag.ac.cn")
      expect(url.searchParams.get("type")).toBe("retrieve")
      expect(url.searchParams.has("token")).toBe(false)
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer deepxiv-fixture-key")
      return Response.json({
        status: "success",
        result: [
          {
            arxiv_id: "2401.12345",
            title: "Original paper",
            abstract,
            tldr: "Generated TLDR",
            authors: ["A. Researcher"],
          },
          { arxiv_id: "2401.99999", title: "Brief only", tldr: "Generated TLDR" },
        ],
      })
    },
    async () => {
      const hits = await searchSkillPapers({ skill: "deepxiv", query: "REBCO", signal: signal() })
      expect(hits[0]?.extra?.materialPaper).toMatchObject({ abstract, arxiv: "2401.12345" })
      expect(hits[1]?.extra?.materialPaper).toMatchObject({ abstract: undefined, arxiv: "2401.99999" })
      expect(JSON.stringify(hits)).not.toContain("Generated TLDR")
    },
  )
})

test("DeepXiv head provides paper metadata without claiming body evidence", async () => {
  delete process.env.DEEPXIV_API_KEY
  process.env.DEEPXIV_TOKEN = "deepxiv-legacy-fixture"
  await transport(
    async (url) => {
      expect(url.searchParams.get("type")).toBe("head")
      expect(url.searchParams.get("arxiv_id")).toBe("2401.12345")
      return Response.json({
        title: "Original paper",
        abstract,
        authors: ["A. Researcher"],
        sections: { Results: 1200 },
      })
    },
    async () => {
      expect(skillAvailability("deepxiv").available).toBe(true)
      const hit = await lookupSkillPaper({ skill: "deepxiv", reference: "2401.12345", signal: signal() })
      expect(hit?.extra?.materialPaper).toMatchObject({ abstract, arxiv: "2401.12345" })
    },
  )
})

test("research-lit merges duplicates and preserves published metadata and PDF alternatives", async () => {
  await transport(
    async (url) => {
      if (url.hostname === "export.arxiv.org") return new Response(atom)
      if (url.hostname === "api.openalex.org") return Response.json({ results: [] })
      return Response.json({ data: [s2] })
    },
    async () => {
      const hits = await searchSkillPapers({ skill: "research-lit", query: "REBCO", signal: signal() })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.extra).toMatchObject({
        materialSkill: "research-lit",
        materialSource: "semantic-scholar",
        venue: "Superconductivity",
      })
      expect(hits[0]?.extra?.materialPaper).toMatchObject({
        doi: "10.1234/pinning",
        pdfURLs: [
          "https://arxiv.org/pdf/2401.12345v1",
          "https://repository.example.org/pinning.pdf",
          "https://arxiv.org/pdf/2401.12345",
        ],
      })
    },
  )
})

test("research-lit retains partial success and identifies a failed source", async () => {
  await transport(
    async (url) => {
      if (url.hostname === "export.arxiv.org") return new Response(atom)
      if (url.hostname === "api.openalex.org") return Response.json({ results: [] })
      return new Response("unauthorized", { status: 401 })
    },
    async () => {
      const hits = await searchSkillPapers({ skill: "research-lit", query: "REBCO", signal: signal() })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.extra?.materialWarnings).toEqual(["semantic-scholar 检索失败"])
    },
  )
})

test("missing credentials and invalid inputs are rejected before network access", async () => {
  delete process.env.EXA_API_KEY
  delete process.env.DEEPXIV_API_KEY
  delete process.env.DEEPXIV_TOKEN
  let calls = 0
  await transport(
    async () => {
      calls++
      return Response.json({})
    },
    async () => {
      await expect(searchSkillPapers({ skill: "exa-search", query: "REBCO", signal: signal() })).rejects.toThrow(
        "EXA_API_KEY",
      )
      await expect(searchSkillPapers({ skill: "deepxiv", query: "REBCO", signal: signal() })).rejects.toThrow(
        "DEEPXIV_API_KEY",
      )
      await expect(searchSkillPapers({ skill: "arxiv", query: "", signal: signal() })).rejects.toThrow()
      await expect(
        searchSkillPapers({ skill: "arxiv", query: "REBCO", limit: 200, signal: signal() }),
      ).rejects.toThrow()
      expect(skillAvailability("arxiv")).toEqual({ available: true })
      expect(skillAvailability("unknown").available).toBe(false)
    },
  )
  expect(calls).toBe(0)
})

test("cancellation is preserved instead of becoming an empty literature result", async () => {
  const controller = new AbortController()
  controller.abort(new Error("stopped"))
  await expect(searchSkillPapers({ skill: "research-lit", query: "REBCO", signal: controller.signal })).rejects.toThrow(
    "stopped",
  )
})

test("malformed successful payloads are not accepted as empty searches", async () => {
  process.env.EXA_API_KEY = "exa-fixture-key"
  process.env.DEEPXIV_API_KEY = "deepxiv-fixture-key"
  await transport(
    async () => Response.json({ status: "failure", tldr: "not a result" }),
    async () => {
      for (const skill of ["semantic-scholar", "exa-search", "deepxiv"]) {
        await expect(searchSkillPapers({ skill, query: "REBCO", signal: signal() })).rejects.toThrow()
      }
    },
  )
})

test("credential values echoed by an upstream error are redacted", async () => {
  process.env.EXA_API_KEY = "exa-fixture-never-log"
  await transport(
    async () => Response.json({ error: "bad key exa-fixture-never-log" }),
    async () => {
      const error = await searchSkillPapers({ skill: "exa-search", query: "REBCO", signal: signal() }).catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain("exa-fixture-never-log")
    },
  )
})
