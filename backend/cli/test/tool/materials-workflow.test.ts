import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { MaterialCreate } from "@synsci/util/materials"
import { MaterialsService, type StageExecutor } from "../../src/materials/workflow"
import { createMaterialsWorkflowTool, MaterialsWorkflowParameters } from "../../src/tool/materials-workflow"
import { ToolVisibility } from "../../src/tool/visibility"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { tmpdir } from "../fixture/fixture"
import type { Tool } from "../../src/tool/tool"

const resources: Array<{ service: MaterialsService; directory: string }> = []
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.service.close()
    rmSync(resource.directory, { recursive: true, force: true })
  }
})
function service(
  executor: StageExecutor = async (_project, _stage, signal) =>
    new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "materials-tool-"))
  const service = new MaterialsService({ directory, executor, pollInterval: 10 })
  resources.push({ service, directory })
  return service
}
function context(overrides: Partial<Tool.Context> = {}): Tool.Context {
  return {
    sessionID: "ses_current",
    messageID: "msg_create",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
    ...overrides,
  }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("Expected materials state not reached")
}
const goal = "研究 PLD 制备 REBCO 薄膜的钉扎机制并提出受控实验方案"

test("a short everyday goal creates a task without invented experimental details", async () => {
  const current = service()
  const tool = await createMaterialsWorkflowTool(async () => current).init()
  const created = await tool.execute({ action: "create", goal: "  提高超导性能\n" }, context())
  const project = current.get(created.metadata.materialsProjectID)
  expect(project.goal).toBe("提高超导性能")
  expect(project.target).toBe("auto")
  expect(project.answers).toBe("")
  expect(project.sessionID).toBe("ses_current")
})

test("empty, whitespace-only and oversized goals cannot create a task or ask for execution", async () => {
  const current = service()
  const tool = await createMaterialsWorkflowTool(async () => current).init()
  let asked = 0
  const ctx = context({
    ask: async () => {
      asked++
    },
  })
  for (const goal of ["", " \n\t", "　", "x".repeat(20_001)]) {
    await expect(tool.execute({ action: "create", goal }, ctx)).rejects.toThrow()
    expect(() => current.create({ goal, requestID: "invalid-goal" })).toThrow()
  }
  expect(current.list()).toHaveLength(0)
  expect(asked).toBe(0)
})

test("materials workflow binds the conversation and selected model, deduplicates creation and survives chat abort", async () => {
  const signals: AbortSignal[] = []
  const current = service(async (_project, _stage, signal) => {
    signals.push(signal)
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  })
  const model = { providerID: "selected-provider", modelID: "selected-model" }
  const tool = await createMaterialsWorkflowTool(async () => current).init({ model })
  const controller = new AbortController()
  const observed: Parameters<Tool.Context["metadata"]>[0][] = []
  const ctx = context({ abort: controller.signal, metadata: (input) => observed.push(input) })
  const first = await tool.execute({ action: "create", goal }, ctx)
  const second = await tool.execute({ action: "create", goal }, ctx)
  expect(first.metadata.materialsProjectID).toBe(second.metadata.materialsProjectID)
  expect(current.list()).toHaveLength(1)
  const project = current.get(first.metadata.materialsProjectID)
  expect(project.sessionID).toBe(ctx.sessionID)
  expect(project.model).toEqual(model)
  expect(observed[0].metadata?.materialsProjectID).toBe(project.id)
  expect(observed[0].metadata?.action).toBe("create")
  expect(first.metadata.action).toBe("create")
  expect(first.output).toContain("本会话")
  expect(first.output).toContain("不需要轮询")
  await until(() => signals.length === 1)
  controller.abort()
  expect(signals[0].aborted).toBe(false)
  const cancelled = await tool.execute(
    { action: "cancel", projectID: project.id },
    context({ messageID: "msg_cancel" }),
  )
  expect(cancelled.metadata.materialsStatus).toBe("cancelled")
  expect(cancelled.metadata.action).toBe("cancel")
  expect(signals[0].aborted).toBe(true)
})

test("all non-create operations reject another conversation before asking or changing state", async () => {
  const current = service()
  const owned = current.create({ goal, target: "auto", requestID: "bound" }, { sessionID: "ses_owner" })
  const unbound = current.create({ goal, target: "auto", requestID: "unbound" })
  let asked = 0
  const tool = await createMaterialsWorkflowTool(async () => current).init()
  for (const action of ["status", "answer", "resume", "cancel", "refresh_literature", "revise_protocol"] as const) {
    await expect(
      tool.execute(
        {
          action,
          projectID: owned.id,
          ...(["answer", "revise_protocol"].includes(action) ? { answers: "PLD 与 77 K" } : {}),
        },
        context({
          ask: async () => {
            asked++
          },
        }),
      ),
    ).rejects.toThrow("当前会话")
  }
  await expect(tool.execute({ action: "status", projectID: unbound.id }, context())).rejects.toThrow("当前会话")
  expect(asked).toBe(0)
})

test("server-owned session binding participates in idempotency and remains immutable", () => {
  const current = service()
  const input = { goal, target: "auto" as const, requestID: "shared-id" }
  const project = current.create(input, { sessionID: "ses_first" })
  expect(current.create(input, { sessionID: "ses_first" }).id).toBe(project.id)
  expect(() => current.create(input, { sessionID: "ses_other" })).toThrow("请求编号")
  expect(() => current.create(input)).toThrow("请求编号")
  expect(MaterialCreate.safeParse({ ...input, sessionID: "ses_first" }).success).toBe(false)
  expect(() =>
    current.store.update(project.id, undefined, (project) => {
      project.sessionID = "ses_other"
    }),
  ).toThrow("Immutable")
})

test("permission rejection and pre-dispatch cancellation cannot create a workflow", async () => {
  const current = service()
  const tool = await createMaterialsWorkflowTool(async () => current).init()
  await expect(
    tool.execute(
      { action: "create", goal },
      context({
        ask: async () => {
          throw new Error("permission denied")
        },
      }),
    ),
  ).rejects.toThrow("permission denied")
  const controller = new AbortController()
  controller.abort(new Error("conversation stopped"))
  await expect(tool.execute({ action: "create", goal }, context({ abort: controller.signal }))).rejects.toThrow(
    "conversation stopped",
  )
  expect(current.list()).toHaveLength(0)
  await expect(tool.execute({ action: "create", goal }, context({ agent: "plan" }))).rejects.toThrow(
    "PLAN_MODE_SIDE_EFFECT_DENIED",
  )
})

test("natural-language answers continue the same project and status returns its current result", async () => {
  const goal = "提高超导性能"
  const answers = "REBCO 薄膜，设备和测量条件还没想好，先了解方向"
  const current = service(async (project, stage) => ({
    title: stage === "intake" ? "研究条件" : "文献汇总",
    markdown: "已保存可供查看的成果",
    data:
      stage === "intake"
        ? {
            title: "REBCO 目标",
            materialSystem: "REBCO",
            objective: goal,
            constraints: project.answers ? ["设备和测量条件待确认"] : [],
            searchQueries: ["REBCO superconducting films performance"],
            questions: project.answers ? [] : ["你想研究哪类超导材料？"],
            target: "literature",
          }
        : { summary: "文献阶段成果" },
  }))
  const tool = await createMaterialsWorkflowTool(async () => current).init()
  const created = await tool.execute({ action: "create", goal, target: "literature" }, context())
  const id = created.metadata.materialsProjectID
  await until(() => current.get(id).status === "needs_input")
  const question = await tool.execute(
    { action: "status", projectID: id },
    context({
      ask: async () => {
        throw new Error("status is read-only")
      },
    }),
  )
  expect(question.output).toContain("哪类超导材料")
  await tool.execute({ action: "answer", projectID: id, answers }, context({ messageID: "msg_answer" }))
  await until(() => current.get(id).status === "completed")
  const result = await tool.execute({ action: "status", projectID: id }, context())
  expect(result.metadata.materialsStatus).toBe("completed")
  expect(result.output).toContain("文献汇总")
  expect(current.get(id).goal).toBe(goal)
  expect(current.get(id).answers).toBe(answers)
  expect(current.get(id).artifacts.filter((item) => item.stage === "intake")).toHaveLength(2)
  expect(current.list()).toHaveLength(1)
})

test("human approval and measurement actions are absent from the agent contract", () => {
  for (const action of ["select_ideas", "approve_protocol", "batch", "analyze"])
    expect(MaterialsWorkflowParameters.safeParse({ action, projectID: `mat_${"0".repeat(32)}` }).success).toBe(false)
  expect(
    MaterialsWorkflowParameters.safeParse({ action: "create", goal, model: { providerID: "other", modelID: "other" } })
      .success,
  ).toBe(false)
  expect(MaterialsWorkflowParameters.safeParse({ action: "answer", projectID: `mat_${"0".repeat(32)}` }).success).toBe(
    false,
  )
})

test("the original research agent receives materials_workflow in its normal registry", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("research")
      const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" }, agent)
      expect(tools.filter((tool) => tool.id === "materials_workflow")).toHaveLength(1)
      expect(ToolVisibility.DEFAULT.has("materials_workflow")).toBe(true)
    },
  })
})
