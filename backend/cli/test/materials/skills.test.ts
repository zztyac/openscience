import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import type { ToolSet } from "ai"
import { materialStages, type MaterialSkillName, type MaterialStage } from "@synsci/util/materials"
import { createMaterialSkillExecutor, skillPaperCandidate } from "../../src/materials/skills"
import { defaultMaterialSkills } from "../../src/materials/skill-config"
import { createMaterialExecutor, streamMaterialModel, type MaterialGenerate } from "../../src/materials/pipeline"
import { ideaProjectFixture, strategyFixture, ideaFixture } from "./pipeline-fixtures"
import { validateOutput } from "../../src/materials/validation"

const summary = "The test REBCO films were prepared by pulsed laser deposition with artificial pinning defects."
const body = `${summary} The critical current density was measured at a fixed temperature and magnetic field.`
const hit = {
  id: "test-paper",
  title: "REBCO test paper",
  url: "https://doi.org/10.1000/test-paper",
  summary: "This is a generated search summary, never original evidence.",
  extra: {
    materialSource: "semantic-scholar",
    materialPaper: {
      doi: "10.1000/test-paper",
      abstract: summary,
      authors: "Test Author",
      pdfURLs: ["https://journal.example/paper.pdf"],
    },
  },
}
const signal = () => new AbortController().signal
function config(stage: MaterialStage, names: MaterialSkillName[] = ["semantic-scholar"]) {
  const result = defaultMaterialSkills()
  for (const stage of materialStages) result.stages[stage] = []
  result.stages[stage] = names
  return result
}
const invoke = async (tools: ToolSet | undefined, name: string, input: unknown) => {
  const execute = tools?.[name]?.execute
  if (!execute) throw new Error(`Missing ${name}`)
  return execute(input, { toolCallId: `test-${name}`, messages: [] })
}
const response = { text: '{"summary":"done"}', model: "fixture/model", inputTokens: 10, outputTokens: 5 }
const base = {
  availability: () => ({ available: true }),
  load: async (name: MaterialSkillName) => `Use ${name} to search and read papers through tools.`,
}

test("search summaries cannot become abstracts or full text", () => {
  const candidate = skillPaperCandidate({ ...hit, extra: { materialPaper: { doi: "10.1000/web" } } }, "exa-search")
  expect(candidate?.source.text).toBe("")
  expect(candidate?.source.kind).toBe("abstract")
  expect(skillPaperCandidate({ ...hit, extra: undefined }, "exa-search")).toBeUndefined()
})

test("different repository document queries cannot collapse into one evidence identity", async () => {
  const first = {
    ...hit,
    url: "https://repository.example/download.pdf?id=first&token=private-one",
    extra: { materialPaper: { abstract: summary } },
  }
  const second = { ...first, url: "https://repository.example/download.pdf?id=second&token=private-two" }
  expect(skillPaperCandidate(first, "exa-search")?.source.id).not.toBe(
    skillPaperCandidate(second, "exa-search")?.source.id,
  )
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("literature", ["exa-search"]),
    search: async () => [first, second],
    generate: async (input) => {
      await invoke(input.tools, "search_papers", { skill: "exa-search", query: "REBCO", limit: 2 })
      return response
    },
  })
  const result = await run(ideaProjectFixture(), "literature", signal())
  expect(result.sources).toHaveLength(4)
  expect(JSON.stringify(result)).not.toContain("private-one")
  expect(JSON.stringify(result)).not.toContain("private-two")
})

for (const stage of materialStages)
  test(`${stage} loads only configured Skills and executes actual tools`, async () => {
    const queries: string[] = []
    const run = createMaterialSkillExecutor({
      ...base,
      config: async () => config(stage),
      search: async (input) => {
        queries.push(input.query)
        return [hit]
      },
      generate: async (input) => {
        expect(input.prompt).toContain("Use semantic-scholar")
        const found = (await invoke(input.tools, "search_papers", {
          skill: "semantic-scholar",
          query: "REBCO pinning",
          limit: 3,
        })) as Array<{ sourceID: string }>
        expect(found).toHaveLength(1)
        return response
      },
    })
    const before = ideaProjectFixture()
    const result = await run(before, stage, signal())
    expect(queries).toEqual(["REBCO pinning"])
    expect(before.sources).toHaveLength(2)
    expect(result.sources).toHaveLength(3)
    expect(result.sources.at(-1)?.text).toBe(summary)
    expect(result.execution?.skills[0]).toMatchObject({ name: "semantic-scholar", status: "completed", calls: 1 })
    expect(result.execution?.skills[0].hash).toHaveLength(64)
  })

test("no configured Skill makes no extra model or tool calls", async () => {
  const before = ideaProjectFixture()
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("literature", []),
    generate: async () => {
      throw new Error("unexpected")
    },
  })
  expect(await run(before, "literature", signal())).toEqual({ sources: before.sources })
})

test("the migrated bundled Skill is loadable by the stage runtime", async () => {
  const run = createMaterialSkillExecutor({
    config: async () => config("literature", ["arxiv"]),
    generate: async (input) => {
      expect(input.prompt).toContain("lookup_paper")
      await invoke(input.tools, "get_evidence", { skill: "arxiv", offset: 0 })
      return response
    },
  })
  const result = await run(ideaProjectFixture(), "literature", signal())
  expect(result.execution?.skills[0]).toMatchObject({ name: "arxiv", status: "completed", calls: 1 })
  expect(result.execution?.skills[0].hash).toHaveLength(64)
})

test("missing credentials are visible and do not trigger registration or model calls", async () => {
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("literature", ["exa-search"]),
    availability: () => ({ available: false, reason: "需要 Exa 凭据" }),
    generate: async () => {
      throw new Error("unexpected")
    },
  })
  const result = await run(ideaProjectFixture(), "literature", signal())
  expect(result.execution?.skills[0]).toMatchObject({ status: "unavailable", calls: 0 })
  expect(result.execution?.warnings).toEqual(["exa-search：需要 Exa 凭据"])
})

test("lookup supplies trusted PDF locations and later stages preserve previously cited abstracts", async () => {
  const before = ideaProjectFixture()
  const original = skillPaperCandidate(hit, "semantic-scholar")!.source
  before.sources.push(original)
  const snapshot = structuredClone(before)
  const locations: string[][] = []
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("ideas"),
    lookup: async () => hit,
    enrich: async (source, options) => {
      locations.push(options.pdfURLs ?? [])
      return { ...source, kind: "fulltext", text: body, chunks: [{ id: `${source.id}:p1`, page: 1, text: body }] }
    },
    generate: async (input) => {
      await invoke(input.tools, "lookup_paper", { skill: "semantic-scholar", reference: original.doi })
      const read = (await invoke(input.tools, "read_paper", { skill: "semantic-scholar", sourceID: original.id })) as {
        sourceID: string
        previousSourceID: string
      }
      expect(read.sourceID).not.toBe(original.id)
      expect(read.previousSourceID).toBe(original.id)
      return response
    },
  })
  const result = await run(before, "ideas", signal())
  expect(before).toEqual(snapshot)
  expect(result.sources.find((source) => source.id === original.id)).toEqual(original)
  expect(result.sources.at(-1)?.kind).toBe("fulltext")
  expect(locations).toEqual([["https://journal.example/paper.pdf"]])
})

test("blocked tools and unrecognized source IDs cannot write model-supplied evidence", async () => {
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("literature"),
    generate: async (input) => {
      expect(
        await invoke(input.tools, "search_papers", { skill: "exa-search", query: "ignored", limit: 1 }),
      ).toHaveProperty("error")
      expect(
        await invoke(input.tools, "read_paper", {
          skill: "semantic-scholar",
          sourceID: "https://attacker.example/file.pdf",
        }),
      ).toHaveProperty("error")
      return { ...response, text: JSON.stringify({ sources: [{ kind: "fulltext", text: "invented" }] }) }
    },
  })
  const before = ideaProjectFixture()
  expect((await run(before, "literature", signal())).sources).toEqual(before.sources)
})

test("a second run creates a new partial-text version instead of changing a saved earlier version", async () => {
  const before = ideaProjectFixture()
  const original = skillPaperCandidate(hit, "semantic-scholar")!.source
  before.sources.push(original)
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("ideas"),
    enrich: async (source) => ({ ...source, kind: "partial", text: body }),
    generate: async (input) => {
      await invoke(input.tools, "read_paper", { skill: "semantic-scholar", sourceID: original.id })
      return response
    },
  })
  const first = await run(before, "ideas", signal())
  const second = await run({ ...before, sources: first.sources }, "ideas", signal())
  expect(second.sources).toHaveLength(first.sources.length + 1)
  expect(second.sources.slice(0, first.sources.length)).toEqual(first.sources)
  expect(new Set(second.sources.map((source) => source.id)).size).toBe(second.sources.length)
})

test("new idea evidence may supplement but cannot replace the selected strategy's evidence", () => {
  const project = ideaProjectFixture()
  const data = ideaFixture(project)
  const extra = skillPaperCandidate(hit, "semantic-scholar")!.source
  project.sources.push(extra)
  data.ideas[0].evidence.push({ sourceID: extra.id, quote: summary })
  expect(() => validateOutput("ideas", data, project)).not.toThrow()
  data.ideas[0].evidence = [{ sourceID: extra.id, quote: summary }]
  expect(() => validateOutput("ideas", data, project)).toThrow("缺少引用策略来源")
})

test("partial failure of an aggregate source is retained in execution warnings", async () => {
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("literature", ["research-lit"]),
    search: async () => [{ ...hit, extra: { ...hit.extra, materialWarnings: ["arxiv 检索失败"] } }],
    generate: async (input) => {
      await invoke(input.tools, "search_papers", { skill: "research-lit", query: "REBCO", limit: 2 })
      return response
    },
  })
  expect((await run(ideaProjectFixture(), "literature", signal())).execution?.warnings).toEqual([
    "research-lit：arxiv 检索失败",
  ])
})

test("cancelled retrieval cannot publish changes and cancellation is not downgraded to a warning", async () => {
  const controller = new AbortController()
  const before = ideaProjectFixture()
  const run = createMaterialSkillExecutor({
    ...base,
    config: async () => config("literature"),
    search: async () => {
      controller.abort(new Error("cancelled by researcher"))
      return [hit]
    },
    generate: async (input) => {
      await invoke(input.tools, "search_papers", { skill: "semantic-scholar", query: "REBCO", limit: 2 })
      return response
    },
  })
  await expect(run(before, "literature", controller.signal)).rejects.toThrow("cancelled by researcher")
  expect(before.sources).toHaveLength(2)
})

test("stage output uses newly admitted evidence and keeps Skill execution metadata", async () => {
  const before = ideaProjectFixture()
  before.artifacts = []
  const seen: string[] = []
  const generate: MaterialGenerate = async (input) => {
    seen.push(input.role)
    if (input.tools) {
      await invoke(input.tools, "search_papers", { skill: "semantic-scholar", query: "REBCO", limit: 2 })
      return response
    }
    expect(input.project.sources).toHaveLength(3)
    return { ...response, text: JSON.stringify(strategyFixture(input.project)) }
  }
  const skills = createMaterialSkillExecutor({
    ...base,
    generate,
    config: async () => config("strategies"),
    search: async () => [hit],
  })
  const execute = createMaterialExecutor({ generate, skills })
  const result = await execute(before, "strategies", signal())
  expect(seen).toEqual(["skills:strategies", "strategy-builder", "strategies:reviewer"])
  expect(result.sources).toHaveLength(3)
  expect(result.data.skillExecution).toHaveProperty("configRevision", 0)
})

test("streaming model transport executes a tool and continues to a final response", async () => {
  const requests: Array<{ messages: Array<{ role: string; content?: string }>; tools?: unknown[] }> = []
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const first = requests.length === 1
      const frame = { id: "skill-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" }
      const chunks = [
        {
          ...frame,
          choices: [
            {
              index: 0,
              delta: first
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_search",
                        type: "function",
                        function: {
                          name: "search_papers",
                          arguments: '{"skill":"semantic-scholar","query":"REBCO","limit":2}',
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: '{"summary":"done"}' },
              finish_reason: null,
            },
          ],
        },
        {
          ...frame,
          choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        },
      ]
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const language = createOpenAI({ apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.port}/v1` }).chat(
      "fixture",
    )
    const run = createMaterialSkillExecutor({
      ...base,
      config: async () => config("literature"),
      search: async () => [hit],
      generate: async (input) => {
        const result = await streamMaterialModel(language, input.prompt, 1000, input.signal, {}, undefined, input)
        return {
          text: result.text,
          model: "fixture/model",
          finishReason: result.finishReason,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }
      },
    })
    const result = await run(ideaProjectFixture(), "literature", signal())
    expect(requests).toHaveLength(2)
    expect(requests[0].tools).toHaveLength(4)
    expect(requests[1].messages.some((message) => message.role === "tool" && message.content?.includes(summary))).toBe(
      true,
    )
    expect(result.execution?.inputTokens).toBe(40)
    expect(result.execution?.calls[0].status).toBe("completed")
    expect(result.sources).toHaveLength(3)
  } finally {
    server.stop(true)
  }
})
