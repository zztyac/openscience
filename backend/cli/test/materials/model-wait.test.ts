import { expect, test } from "bun:test"
import type { MaterialActivityUpdate, MaterialReporter } from "@synsci/util/materials"
import { Config } from "../../src/config/config"
import { generateMaterial } from "../../src/materials/pipeline"
import { ideaProjectFixture } from "./pipeline-fixtures"

const encoder = new TextEncoder()
const providerID = "materials-model-wait-fixture"
const modelID = "fixture"
const response = {
  id: "resp_materials_wait",
  object: "response",
  model: modelID,
  created_at: 1,
  status: "completed",
  output: [],
  usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
}

function frame(event: unknown) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

async function configure(port: number) {
  // The backend preload isolates all global config and credentials in a temporary home.
  await Config.setProvider(providerID, {
    name: "Local material wait fixture",
    npm: "@ai-sdk/openai",
    env: [],
    options: {
      apiKey: "local-fixture-only",
      baseURL: `http://127.0.0.1:${port}/v1`,
      timeout: 20,
      connectTimeout: 20,
      idleTimeout: 20,
      outputIdleTimeout: 20,
    },
    models: { [modelID]: { name: "Fixture", limit: { context: 128_000, output: 4_096 } } },
  })
  return {
    async [Symbol.asyncDispose]() {
      await Config.removeProvider(providerID)
    },
  }
}

function generate(signal: AbortSignal, report?: MaterialReporter) {
  const project = ideaProjectFixture()
  project.model = { providerID, modelID }
  return generateMaterial({ project, stage: "strategies", prompt: "fixture", role: "strategy-builder", signal, report })
}

test("material generation waits for headers and full output beyond configured provider deadlines", async () => {
  const requests: Array<{ stream?: boolean }> = []
  const received = Promise.withResolvers<void>()
  const generating = Promise.withResolvers<void>()
  const activity: MaterialActivityUpdate[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      received.resolve()
      await Bun.sleep(100)
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(frame({ type: "response.created", response }))
            await Bun.sleep(100)
            if (request.signal.aborted) return
            controller.enqueue(
              frame({
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", role: "assistant", content: [], id: "msg_fixture", status: "in_progress" },
              }),
            )
            controller.enqueue(
              frame({
                type: "response.output_text.delta",
                item_id: "msg_fixture",
                output_index: 0,
                content_index: 0,
                delta: '{"summary":',
              }),
            )
            await Bun.sleep(100)
            if (request.signal.aborted) return
            controller.enqueue(
              frame({
                type: "response.output_text.delta",
                item_id: "msg_fixture",
                output_index: 0,
                content_index: 0,
                delta: '"完整的阶段结果"}',
              }),
            )
            controller.enqueue(frame({ type: "response.completed", response }))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await using configured = await configure(server.port!)
    let finished = false
    const pending = generate(new AbortController().signal, (update) => {
      activity.push(update)
      if (update.phase === "generating") generating.resolve()
    }).then((result) => {
      finished = true
      return result
    })
    await received.promise
    expect(activity.map((entry) => entry.phase)).toEqual(["preparing", "waiting"])
    expect(activity[0]).toMatchObject({ role: "strategy-builder", model: `${providerID}/${modelID}` })
    expect(finished).toBe(false)
    await generating.promise
    expect(finished).toBe(false)
    expect(activity.at(-1)).toMatchObject({ phase: "generating", outputChars: '{"summary":'.length })
    expect(activity.some((entry) => entry.phase === "completed")).toBe(false)
    const result = await pending
    expect(requests).toHaveLength(1)
    expect(requests[0].stream).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ summary: "完整的阶段结果" })
    expect(result).toMatchObject({ model: `${providerID}/${modelID}`, inputTokens: 20, outputTokens: 10 })
    expect(activity.at(-1)).toMatchObject({ phase: "generating", outputChars: result.text.length })
    expect(JSON.stringify(activity)).not.toContain("完整的阶段结果")
  } finally {
    server.stop(true)
  }
})

test("material generation can still be explicitly cancelled while the model is silent", async () => {
  const received = Promise.withResolvers<void>()
  const cancellation = new AbortController()
  const reason = new Error("fixture user cancellation")
  let requests = 0
  const activity: MaterialActivityUpdate[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      received.resolve()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame({ type: "response.created", response }))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await using configured = await configure(server.port!)
    const pending = generate(cancellation.signal, (update) => activity.push(update)).catch((error: unknown) => error)
    await received.promise
    await Bun.sleep(100)
    cancellation.abort(reason)
    const reported = activity.length
    expect(await pending).toBe(reason)
    expect(requests).toBe(1)
    expect(activity).toHaveLength(reported)
    expect(activity.some((entry) => entry.phase === "completed")).toBe(false)
  } finally {
    cancellation.abort(reason)
    server.stop(true)
  }
})

test("reasoning reports live activity without exposing its text or counting it as result output", async () => {
  const activity: MaterialActivityUpdate[] = []
  const reasoning = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const hidden = "private reasoning fixture: Authorization secret and internal scientific deliberation"
  const output = '{"summary":"private result fixture"}'
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (event: unknown) => controller.enqueue(frame(event))
            send({ type: "response.created", response })
            send({
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "reasoning", id: "rs_fixture", summary: [] },
            })
            send({
              type: "response.reasoning_summary_part.added",
              item_id: "rs_fixture",
              output_index: 0,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            })
            send({
              type: "response.reasoning_summary_text.delta",
              item_id: "rs_fixture",
              output_index: 0,
              summary_index: 0,
              delta: hidden,
            })
            await release.promise
            send({
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: hidden }] },
            })
            send({
              type: "response.output_item.added",
              output_index: 1,
              item: { type: "message", role: "assistant", content: [], id: "msg_fixture", status: "in_progress" },
            })
            send({
              type: "response.output_text.delta",
              item_id: "msg_fixture",
              output_index: 1,
              content_index: 0,
              delta: output,
            })
            send({ type: "response.completed", response })
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await using configured = await configure(server.port!)
    let finished = false
    const pending = generate(new AbortController().signal, (update) => {
      activity.push(update)
      if (update.phase === "reasoning") reasoning.resolve()
    }).then((result) => {
      finished = true
      return result
    })
    await Promise.race([
      reasoning.promise,
      pending.then(() => {
        throw new Error("Reasoning activity was not reported")
      }),
    ])
    expect(finished).toBe(false)
    expect(activity.at(-1)).toMatchObject({ phase: "reasoning", outputChars: 0 })
    expect(activity.some((entry) => entry.phase === "completed")).toBe(false)
    expect(JSON.stringify(activity)).not.toContain(hidden)
    release.resolve()
    const result = await pending
    expect(result.text).toBe(output)
    expect(activity.at(-1)).toMatchObject({ phase: "generating", outputChars: output.length })
    expect(JSON.stringify(activity)).not.toContain("private result fixture")
    expect(JSON.stringify(activity)).not.toContain("local-fixture-only")
    expect(JSON.stringify(activity)).not.toContain("127.0.0.1")
  } finally {
    release.resolve()
    server.stop(true)
  }
})
