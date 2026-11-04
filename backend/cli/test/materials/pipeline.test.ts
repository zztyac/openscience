import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createOpenAI } from "@ai-sdk/openai"
import {
  MaterialIdeas,
  type MaterialActivityUpdate,
  type MaterialProject,
  type MaterialStage,
} from "@synsci/util/materials"
import {
  createMaterialExecutor,
  materialProviderOptions,
  streamMaterialModel,
  validateIdeaTransition,
  type MaterialGenerate,
} from "../../src/materials/pipeline"
import { sourceFromHit } from "../../src/materials/literature"
import { MaterialsService, type StageExecutor } from "../../src/materials/workflow"
import {
  analysisFixture,
  excerpts,
  flowRoles,
  intakeFixture,
  modelFixture,
  ideaFixture,
  ideaProjectFixture,
  paperInputs,
  scriptedGenerator,
} from "./pipeline-fixtures"

const services: MaterialsService[] = []
const directories: string[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function service(executor: StageExecutor) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "materials-pipeline-test-"))
  directories.push(directory)
  const result = new MaterialsService({ directory, executor, concurrency: 1, pollInterval: 10 })
  services.push(result)
  return result
}

const input = {
  goal: "研究 REBCO 薄膜的 APC 与多层界面钉扎，先规划人工实验再回填数据",
  target: "protocol" as const,
  requestID: "pipeline-fixture-request",
}

async function until(service: MaterialsService, id: string, check: (project: MaterialProject) => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const project = service.get(id)
    if (check(project)) return project
    if (project.status === "failed") throw new Error(`Unexpected pipeline failure: ${project.error}`)
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for pipeline state: ${service.get(id).status}`)
}

const savedSourcesOnly = async (project: MaterialProject, signal: AbortSignal) => {
  signal.throwIfAborted()
  return { sources: project.sources, gaps: [] }
}

describe("material model transport", () => {
  test("uses streaming requests and collects the complete response before returning stage JSON", async () => {
    const requests: Array<{ stream?: boolean; reasoning_effort?: string }> = []
    const encoder = new TextEncoder()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const payload = (await request.json()) as { stream?: boolean; reasoning_effort?: string }
        requests.push(payload)
        if (!payload.stream)
          return Response.json({ error: { message: "Non-streaming requests exceed gateway limits" } }, { status: 504 })
        return new Response(
          new ReadableStream({
            async start(controller) {
              const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
              const frame = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture" }
              send({
                ...frame,
                choices: [{ index: 0, delta: { role: "assistant", content: '{"summary":' }, finish_reason: null }],
              })
              controller.enqueue(encoder.encode(": gateway heartbeat\n\n"))
              await Bun.sleep(20)
              send({ ...frame, choices: [{ index: 0, delta: { content: '"完整的阶段结果"}' }, finish_reason: null }] })
              send({
                ...frame,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
              })
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      const model = createOpenAI({ apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.port}/v1` }).chat(
        "fixture",
      )
      const options = materialProviderOptions(
        { ...modelFixture, options: { reasoningEffort: "high" } },
        {},
        "materials:fixture",
      )
      const result = await streamMaterialModel(model, "只返回测试 JSON", 1000, new AbortController().signal, options)
      expect(requests).toHaveLength(1)
      expect(requests[0].stream).toBe(true)
      expect(requests[0].reasoning_effort).toBe("high")
      expect(JSON.parse(result.text)).toEqual({ summary: "完整的阶段结果" })
      expect(result.finishReason).toBe("stop")
      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 })
    } finally {
      server.stop(true)
    }
  })

  test("preserves configured max reasoning through the Responses transport used by the Provider", async () => {
    const requests: Array<{ stream?: boolean; reasoning?: { effort?: string; summary?: string } }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(await request.json())
        const response = {
          id: "resp_fixture",
          object: "response",
          model: "gpt-6-astra",
          created_at: 1,
          status: "completed",
          output: [],
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        }
        const events = [
          { type: "response.created", response },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", role: "assistant", content: [], id: "msg_fixture", status: "in_progress" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_fixture",
            output_index: 0,
            content_index: 0,
            delta: '{"summary":"已保留推理配置"}',
          },
          { type: "response.completed", response },
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    try {
      const model = createOpenAI({ apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.port}/v1` }).responses(
        "gpt-6-astra",
      )
      const options = materialProviderOptions(modelFixture, {}, "materials:fixture")
      expect(options.openai).toMatchObject({ reasoningEffort: "max", reasoningSummary: "auto" })
      const result = await streamMaterialModel(model, "fixture", 1000, new AbortController().signal, options)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ stream: true, reasoning: { effort: "max", summary: "auto" } })
      expect(JSON.parse(result.text)).toEqual({ summary: "已保留推理配置" })
      expect(result.finishReason).toBe("stop")
    } finally {
      server.stop(true)
    }
  })

  test("reports gateway failures without exposing response details or retrying paid requests", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return Response.json(
          { error: { message: "Gateway Timeout fixture-private-response-do-not-log" } },
          { status: 504 },
        )
      },
    })
    try {
      const model = createOpenAI({ apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.port}/v1` }).chat(
        "fixture",
      )
      const result = await streamMaterialModel(model, "fixture", 1000, new AbortController().signal).catch(
        (error: unknown) => error,
      )
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain("模型网关暂时不可用")
      expect((result as Error).message).not.toContain("fixture-private-response")
      expect(requests).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test("rejects a stream that ends without a completion marker even after it delivered valid JSON", async () => {
    const encoder = new TextEncoder()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            async start(controller) {
              const partial = {
                id: "partial-fixture",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture",
                choices: [
                  { index: 0, delta: { role: "assistant", content: '{"summary":"partial"}' }, finish_reason: null },
                ],
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(partial)}\n\n`))
              await Bun.sleep(20)
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      const model = createOpenAI({ apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.port}/v1` }).chat(
        "fixture",
      )
      await expect(streamMaterialModel(model, "fixture", 1000, new AbortController().signal)).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })

  for (const timeout of [false, true]) {
    test(`preserves ${timeout ? "a safe timeout error" : "user cancellation"} when the SDK has no output`, async () => {
      const cancellation = new AbortController()
      const reason = timeout
        ? new DOMException("fixture-private-timeout", "TimeoutError")
        : new Error("fixture user cancellation")
      let timer: ReturnType<typeof setTimeout> | undefined
      let requests = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          requests++
          timer = setTimeout(() => cancellation.abort(reason), 25)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": heartbeat while reasoning\n\n"))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        const model = createOpenAI({ apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.port}/v1` }).chat(
          "fixture",
        )
        const result = await streamMaterialModel(model, "fixture", 1000, cancellation.signal).catch(
          (error: unknown) => error,
        )
        if (timeout) {
          expect(result).toBeInstanceOf(Error)
          expect((result as Error).message).toContain("模型接口或网络连接超时")
          expect((result as Error).message).not.toContain("fixture-private-timeout")
        } else expect(result).toBe(reason)
        expect(requests).toBe(1)
      } finally {
        clearTimeout(timer)
        server.stop(true)
      }
    })
  }
})

function ideaGenerator(change: (data: ReturnType<typeof ideaFixture>, role: string) => void) {
  const calls: string[] = []
  const generate: MaterialGenerate = async (input) => {
    calls.push(input.role)
    if (calls.length > 10) throw new Error("The bounded transition fixture exhausted its calls")
    const role = input.role.replace(/:repair$/, "")
    const data = ideaFixture(input.project, role)
    change(data, input.role)
    return { text: JSON.stringify(data), model: "fixture/transition", inputTokens: 10, outputTokens: 20 }
  }
  return { generate, calls }
}

describe("idea role transition guards", () => {
  test("allows scientific review decisions, ranking order and properly gated new candidates", () => {
    const project = ideaProjectFixture()
    const before = ideaFixture(project)
    const review = structuredClone(before)
    review.ideas[0].review = { decision: "revise", rationale: "需要更具体的对照", issues: ["对照不足"] }
    expect(() => validateIdeaTransition(before, review, "review")).not.toThrow()
    const ranked = structuredClone(before)
    ranked.ideas[0].rank = 2
    ranked.comparison = "补充了接近度与科学空白分析。"
    expect(() => validateIdeaTransition(before, ranked, "ranking")).not.toThrow()
    expect(() => validateIdeaTransition(before, ideaFixture(project, "idea-evolution"), "evolution")).not.toThrow()
    expect(() =>
      validateIdeaTransition(
        ideaFixture(project, "idea-evolution"),
        ideaFixture(project, "idea-final-review"),
        "review",
      ),
    ).not.toThrow()
  })

  test("review and ranking preserve the exact candidate ID set", () => {
    const project = ideaProjectFixture()
    const before = ideaFixture(project, "idea-final-review")
    const removed = structuredClone(before)
    removed.ideas.pop()
    for (const mode of ["review", "ranking"] as const) {
      expect(() => validateIdeaTransition(before, removed, mode)).toThrow()
      const replaced = structuredClone(before)
      replaced.ideas[0].id = "another-idea"
      expect(() => validateIdeaTransition(before, replaced, mode)).toThrow()
      const duplicate = structuredClone(before)
      duplicate.ideas[0].id = duplicate.ideas[1].id
      expect(() => validateIdeaTransition(before, duplicate, mode)).toThrow()
    }
  })

  const violations: Array<{
    name: string
    role: string
    mutate: (data: ReturnType<typeof ideaFixture>) => void
    expected: string[]
  }> = [
    {
      name: "a reviewer rewrites a hypothesis",
      role: "ideas:reviewer",
      mutate: (data) => {
        data.ideas[0].hypothesis = "这是审查者擅自创建的不同科学假设"
      },
      expected: ["idea-expert", "ideas:reviewer", "ideas:reviewer:repair"],
    },
    {
      name: "ranking changes scientific design",
      role: "idea-proximity-ranking",
      mutate: (data) => {
        data.ideas[0].design = "排序阶段擅自更换材料路线"
      },
      expected: ["idea-expert", "ideas:reviewer", "idea-proximity-ranking", "idea-proximity-ranking:repair"],
    },
    {
      name: "ranking silently replaces a nested evidence quotation",
      role: "idea-proximity-ranking",
      mutate: (data) => {
        data.ideas[0].evidence[0].quote = excerpts.limitation
      },
      expected: ["idea-expert", "ideas:reviewer", "idea-proximity-ranking", "idea-proximity-ranking:repair"],
    },
    {
      name: "ranking changes an independent review",
      role: "idea-proximity-ranking",
      mutate: (data) => {
        data.ideas[0].review.rationale = "排序阶段覆写独立审查结论"
      },
      expected: ["idea-expert", "ideas:reviewer", "idea-proximity-ranking", "idea-proximity-ranking:repair"],
    },
    {
      name: "evolution overwrites a parent candidate",
      role: "idea-evolution",
      mutate: (data) => {
        data.ideas[0].mechanism = "保留旧 ID 却替换核心机制"
      },
      expected: ["idea-expert", "ideas:reviewer", "idea-proximity-ranking", "idea-evolution", "idea-evolution:repair"],
    },
    {
      name: "evolution erases a parent candidate",
      role: "idea-evolution",
      mutate: (data) => {
        data.ideas = data.ideas.filter((idea) => idea.id !== "idea1")
      },
      expected: ["idea-expert", "ideas:reviewer", "idea-proximity-ranking", "idea-evolution", "idea-evolution:repair"],
    },
    {
      name: "evolution overwrites its parent's independent review",
      role: "idea-evolution",
      mutate: (data) => {
        data.ideas[0].review.issues.push("演化角色擅自覆盖评审内容")
      },
      expected: ["idea-expert", "ideas:reviewer", "idea-proximity-ranking", "idea-evolution", "idea-evolution:repair"],
    },
    {
      name: "evolution self-accepts its new candidate",
      role: "idea-evolution",
      mutate: (data) => {
        data.ideas.find((idea) => idea.id === "idea2")!.review.decision = "accept"
      },
      expected: ["idea-expert", "ideas:reviewer", "idea-proximity-ranking", "idea-evolution", "idea-evolution:repair"],
    },
    {
      name: "the final reviewer changes an evolved scientific claim",
      role: "idea-final-review",
      mutate: (data) => {
        data.ideas.find((idea) => idea.id === "idea2")!.design = "最终审查时再次更换了未审查的新设计"
      },
      expected: [
        "idea-expert",
        "ideas:reviewer",
        "idea-proximity-ranking",
        "idea-evolution",
        "idea-final-review",
        "idea-final-review:repair",
      ],
    },
  ]
  for (const violation of violations) {
    test(`rejects after one repair when ${violation.name}`, async () => {
      const fixture = ideaGenerator((data, role) => {
        if (role.replace(/:repair$/, "") === violation.role) violation.mutate(data)
      })
      const execute = createMaterialExecutor({ skills: false, generate: fixture.generate, search: savedSourcesOnly })
      await expect(execute(ideaProjectFixture(), "ideas", new AbortController().signal)).rejects.toThrow("未通过")
      expect(fixture.calls).toEqual(violation.expected)
    })
  }

  test("one corrected ranking repair restores the valid workflow and records the repair call", async () => {
    const activity: MaterialActivityUpdate[] = []
    const fixture = ideaGenerator((data, role) => {
      if (role === "idea-proximity-ranking") data.ideas[0].design = "首次排序违规更改设计"
    })
    const execute = createMaterialExecutor({ skills: false, generate: fixture.generate, search: savedSourcesOnly })
    const result = await execute(ideaProjectFixture(), "ideas", new AbortController().signal, (update) =>
      activity.push(update),
    )
    expect(fixture.calls).toEqual([
      "idea-expert",
      "ideas:reviewer",
      "idea-proximity-ranking",
      "idea-proximity-ranking:repair",
      "idea-evolution",
      "idea-final-review",
    ])
    expect(MaterialIdeas.parse(result.data).ideas.find((idea) => idea.id === "idea1")?.design).toBe(
      ideaFixture(ideaProjectFixture()).ideas[0].design,
    )
    expect(result.data.execution).toEqual(
      fixture.calls.map((role) => ({ role, model: "fixture/transition", inputTokens: 10, outputTokens: 20 })),
    )
    expect(MaterialIdeas.parse(result.data).ideas.find((idea) => idea.id === "idea2")?.review.decision).toBe("accept")
    expect(
      activity
        .filter((entry) => entry.phase === "preparing" || entry.phase === "repairing")
        .map((entry) => ({ phase: entry.phase, role: entry.role, step: entry.step, steps: entry.steps })),
    ).toEqual([
      { phase: "preparing", role: "idea-expert", step: 1, steps: 5 },
      { phase: "preparing", role: "ideas:reviewer", step: 2, steps: 5 },
      { phase: "preparing", role: "idea-proximity-ranking", step: 3, steps: 5 },
      { phase: "repairing", role: "idea-proximity-ranking:repair", step: 3, steps: 5 },
      { phase: "preparing", role: "idea-evolution", step: 4, steps: 5 },
      { phase: "preparing", role: "idea-final-review", step: 5, steps: 5 },
    ])
    expect(activity.filter((entry) => entry.phase === "validating").map((entry) => entry.role)).toEqual(fixture.calls)
    expect(
      activity.filter((entry) => entry.phase === "validating").every((entry) => entry.model === "fixture/transition"),
    ).toBe(true)
    expect(activity.some((entry) => entry.phase === "completed")).toBe(false)
    expect(JSON.stringify(activity)).not.toContain("首次排序违规更改设计")
  })
})

describe("materials pipeline integration", () => {
  test("runs a grounded research workflow with real gates, lineage, reviewer roles and measured statistics", async () => {
    const fixture = scriptedGenerator()
    const searches: number[] = []
    const activity: Array<MaterialActivityUpdate & { stage: MaterialStage }> = []
    const executor = createMaterialExecutor({
      skills: false,
      generate: fixture.generate,
      search: async (project, signal) => {
        searches.push(project.sources.length)
        return savedSourcesOnly(project, signal)
      },
    })
    const current = service((project, stage, signal, report) =>
      executor(project, stage, signal, (update) => {
        activity.push({ ...update, stage })
        report?.(update)
      }),
    )
    const created = current.create(input)
    const question = await until(current, created.id, (project) => project.status === "needs_input")
    expect(question.questions).toHaveLength(1)
    expect(question.artifacts.map((item) => item.stage)).toEqual(["intake"])
    expect(fixture.calls.map((call) => call.role)).toEqual(["intake"])

    current.decide(created.id, {
      action: "answer",
      revision: question.revision,
      answers: "PLD 设备可用；77 K、1 T，角度为 0°。",
    })
    const missing = await until(current, created.id, (project) => project.status === "failed")
    expect(missing.error).toContain("可引用的文献证据")
    expect(missing.artifacts.map((item) => item.stage)).toEqual(["intake", "intake"])
    for (const source of paperInputs) current.source(created.id, source)
    const sourced = current.get(created.id)
    expect(sourced.sources.map((source) => source.text)).toEqual(paperInputs.map((source) => source.text))
    expect(sourced.sources.every((source) => source.origin === "upload")).toBe(true)

    current.decide(created.id, { action: "resume", revision: sourced.revision })
    const choice = await until(current, created.id, (project) => project.status === "awaiting_approval")
    expect(searches).toEqual([0, 2])
    expect(choice.artifacts.map((item) => item.stage)).toEqual([
      "intake",
      "intake",
      "literature",
      "strategies",
      "ideas",
    ])
    const literature = choice.artifacts.find((item) => item.stage === "literature")!
    const strategies = choice.artifacts.find((item) => item.stage === "strategies")!
    const ideas = choice.artifacts.find((item) => item.stage === "ideas")!
    expect(literature.inputArtifactIDs).toEqual([choice.artifacts[1].id])
    expect(strategies.inputArtifactIDs).toEqual([choice.artifacts[1].id, literature.id])
    expect(ideas.inputArtifactIDs).toEqual([choice.artifacts[1].id, literature.id, strategies.id])
    expect(ideas.inputArtifactIDs).not.toContain(choice.artifacts[0].id)
    expect(strategies.markdown).toContain(excerpts.strategy)
    expect(strategies.markdown).toContain(sourced.sources[0].id)
    expect(ideas.markdown).toContain("待实验验证")
    expect(MaterialIdeas.parse(ideas.data).ideas.find((idea) => idea.id === "idea2")?.review.decision).toBe("accept")
    expect(ideas.data.execution).toEqual(
      flowRoles
        .slice(4, 9)
        .map((role) => ({ role, model: "fixture/finite-material-model", inputTokens: 101, outputTokens: 202 })),
    )

    current.decide(created.id, { action: "select_ideas", revision: choice.revision, ideaIDs: ["idea2"] })
    const approval = await until(
      current,
      created.id,
      (project) =>
        project.status === "awaiting_approval" && project.artifacts.some((item) => item.stage === "protocol"),
    )
    const protocol = approval.artifacts.at(-1)!
    expect(protocol.stage).toBe("protocol")
    expect(protocol.inputArtifactIDs).toEqual([approval.artifacts[1].id, literature.id, strategies.id, ideas.id])
    expect(protocol.data.ideaIDs).toEqual(["idea2"])
    expect(protocol.data.execution).toEqual(
      flowRoles
        .slice(9, 11)
        .map((role) => ({ role, model: "fixture/finite-material-model", inputTokens: 101, outputTokens: 202 })),
    )
    expect(protocol.markdown).toContain("需研究人员确认后执行")
    expect(approval.batches).toHaveLength(0)
    current.decide(created.id, { action: "approve_protocol", revision: approval.revision, protocolID: protocol.id })
    const approved = current.get(created.id)
    expect(approved.status).toBe("awaiting_data")
    expect(fixture.calls.map((call) => call.role)).toEqual(flowRoles.slice(0, -1))

    const rawCSV =
      "sampleID,groupID,property,value,unit,temperatureK,fieldT,angleDeg\nc1,control,Jc,1,MA/cm2,77,1,0\nc2,control,Jc,3,MA/cm2,77,1,0\nt1,treated,Jc,3,MA/cm2,77,1,0\nt2,treated,Jc,5,MA/cm2,77,1,0"
    const measured = current.batch(created.id, {
      revision: approved.revision,
      protocolID: protocol.id,
      name: "人工测量批次",
      rawCSV,
      measurements: [
        { sampleID: "c1", groupID: "control", value: 1 },
        { sampleID: "c2", groupID: "control", value: 3 },
        { sampleID: "t1", groupID: "treated", value: 3 },
        { sampleID: "t2", groupID: "treated", value: 5 },
      ].map((row) => ({
        ...row,
        property: "Jc",
        unit: "MA/cm2",
        temperatureK: 77,
        fieldT: 1,
        angleDeg: 0,
        notes: "人工填写",
        process: "PLD",
      })),
    })
    current.decide(created.id, { action: "analyze", revision: measured.revision })
    const complete = await until(current, created.id, (project) => project.status === "completed")
    const analysis = complete.artifacts.at(-1)!
    expect(analysis.stage).toBe("analysis")
    expect(analysis.inputArtifactIDs).toEqual([protocol.id, measured.batches[0].id])
    expect(analysis.data).toMatchObject({
      ...analysisFixture,
      statistics: {
        groups: [
          { groupID: "control", recordCount: 2, sampleCount: 2, mean: 2, min: 1, max: 3 },
          { groupID: "treated", recordCount: 2, sampleCount: 2, mean: 4, min: 3, max: 5 },
        ],
      },
    })
    expect(complete.batches[0].rawCSV).toBe(rawCSV)
    expect(complete.batches[0].measurements).toEqual(measured.batches[0].measurements)
    expect(complete.artifacts.find((item) => item.id === protocol.id)).toEqual(protocol)
    expect(fixture.calls.map((call) => call.role)).toEqual(flowRoles)
    expect(analysis.markdown).toContain(analysisFixture.hypothesisAssessment)
    expect(analysis.data.execution).toEqual([
      { role: "analysis", model: "fixture/finite-material-model", inputTokens: 101, outputTokens: 202 },
    ])
    for (const [stage, total] of [
      ["intake", 1],
      ["strategies", 2],
      ["ideas", 5],
      ["protocol", 2],
      ["analysis", 1],
    ] as const) {
      const prepared = activity.filter((entry) => entry.stage === stage && entry.phase === "preparing")
      expect(prepared.length).toBe(stage === "intake" ? 2 : total)
      expect(prepared.every((entry) => entry.steps === total)).toBe(true)
      expect(prepared.at(-1)?.step).toBe(total)
    }
  })

  test("allows exactly one repair for malformed model output and persists no invalid artifact", async () => {
    const roles: string[] = []
    const generate: MaterialGenerate = async (call) => {
      roles.push(call.role)
      if (roles.length > 2) throw new Error("The invalid fixture must not be retried more than once")
      return { text: JSON.stringify({ title: "invalid", success: true }), model: "fixture/invalid" }
    }
    const current = service(createMaterialExecutor({ skills: false, generate, search: savedSourcesOnly }))
    const created = current.create(input)
    const failed = await until(current, created.id, (project) => project.status === "failed")
    expect(roles).toEqual(["intake", "intake:repair"])
    expect(failed.error).toContain("未通过证据或结构校验")
    expect(failed.artifacts).toHaveLength(0)
    expect(failed.stages.find((stage) => stage.key === "intake")?.status).toBe("failed")
  })

  test("aborting a pending model call prevents repair, review and committing a late response", async () => {
    const entered = Promise.withResolvers<Parameters<MaterialGenerate>[0]>()
    const response = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const roles: string[] = []
    const executor = createMaterialExecutor({
      skills: false,
      generate: async (call) => {
        roles.push(call.role)
        entered.resolve(call)
        await response.promise
        return { text: JSON.stringify(intakeFixture(call.project)), model: "fixture/delayed" }
      },
      search: savedSourcesOnly,
    })
    const current = service(async (...args) => {
      try {
        return await executor(...args)
      } finally {
        settled.resolve()
      }
    })
    const created = current.create(input)
    const call = await entered.promise
    current.decide(created.id, { action: "cancel", revision: current.get(created.id).revision })
    expect(call.signal.aborted).toBe(true)
    response.resolve()
    await settled.promise
    expect(roles).toEqual(["intake"])
    expect(current.get(created.id).status).toBe("cancelled")
    expect(current.get(created.id).artifacts).toHaveLength(0)
  })

  test("a literature stage cannot manufacture evidence from a summary or notes", async () => {
    const fixture = scriptedGenerator(["intake", "intake"])
    const current = service(
      createMaterialExecutor({
        skills: false,
        generate: fixture.generate,
        search: async (project) => ({
          sources: project.sources,
          gaps: ["A search summary claims there are many relevant papers, but no source text was retrieved."],
        }),
      }),
    )
    const created = current.create({ ...input, target: "literature" })
    const question = await until(current, created.id, (project) => project.status === "needs_input")
    current.source(created.id, {
      title: "个人检索笔记",
      kind: "note",
      text: "Authors, journal, publication year and search query are metadata, not paper evidence.",
    })
    current.decide(created.id, {
      action: "answer",
      revision: current.get(created.id).revision,
      answers: "77 K、1 T，PLD。",
    })
    const failed = await until(current, created.id, (project) => project.status === "failed")
    expect(question.artifacts).toHaveLength(1)
    expect(failed.error).toContain("可引用的文献证据")
    expect(failed.artifacts.every((item) => item.stage === "intake")).toBe(true)
    expect(fixture.calls.map((call) => call.role)).toEqual(["intake", "intake"])
  })
})

describe("literature source admission", () => {
  test("does not mistake bibliographic search summaries for OpenAlex or Crossref abstracts", () => {
    const base = {
      id: "fixture-id",
      title: "Metadata-only result",
      summary: "Author A, Author B, Journal of Materials, 2025. REBCO pinning paper indexed here.",
    }
    expect(
      sourceFromHit(
        { ...base, extra: { publication_year: 2025, authorships: [{ author: { display_name: "Fixture Author" } }] } },
        "openalex",
      ),
    ).toBeUndefined()
    expect(sourceFromHit({ ...base, extra: { abstract_inverted_index: null } }, "openalex")).toBeUndefined()
    expect(
      sourceFromHit({ ...base, extra: { author: [{ given: "Fixture", family: "Author" }] } }, "crossref"),
    ).toBeUndefined()
    expect(sourceFromHit({ ...base, extra: { abstract: "<jats:p> </jats:p>" } }, "crossref")).toBeUndefined()
  })

  test("retains only actual upstream abstract text and stable source identity", () => {
    const words = excerpts.strategy.split(" ")
    const index = words.reduce<Record<string, number[]>>((result, word, position) => {
      result[word] = [...(result[word] ?? []), position]
      return result
    }, {})
    const oa = sourceFromHit(
      {
        id: "W-fixture",
        title: "Fixture abstract",
        summary: "This is unrelated bibliographic metadata.",
        extra: { doi: "https://doi.org/10.1000/FIXTURE", publication_year: 2025, abstract_inverted_index: index },
      },
      "openalex",
    )
    const cr = sourceFromHit(
      {
        id: "crossref-fixture",
        title: "Fixture abstract",
        extra: { DOI: "10.1000/fixture", abstract: `<jats:p>${excerpts.strategy}</jats:p>` },
      },
      "crossref",
    )
    expect(oa?.text).toBe(excerpts.strategy)
    expect(cr?.text).toBe(excerpts.strategy)
    expect(oa?.id).toBe(cr?.id)
    expect(oa?.kind).toBe("abstract")
    expect(cr?.origin).toBe("crossref")
  })
})
