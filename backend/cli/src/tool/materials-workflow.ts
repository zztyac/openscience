import { createHash } from "node:crypto"
import z from "zod"
import { MaterialTarget, type MaterialProject } from "@synsci/util/materials"
import { MaterialError } from "../materials/store"
import { materialsService, type MaterialsService } from "../materials/workflow"
import { Tool } from "./tool"
import DESCRIPTION from "./materials-workflow.txt"

export const MaterialsWorkflowParameters = z
  .object({
    action: z.enum(["create", "status", "answer", "resume", "cancel", "refresh_literature", "revise_protocol"]),
    projectID: z
      .string()
      .regex(/^mat_[a-f0-9]{32}$/)
      .optional()
      .describe("Existing project ID returned by this tool in this conversation; required except for create."),
    goal: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        "The user's own research goal, even a short everyday phrase, plus known conversation constraints; required for create. Do not invent missing details.",
      ),
    target: MaterialTarget.optional().describe("Optional endpoint for create; auto selects from the goal."),
    answers: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        "The user's clarification answers or protocol revision instructions; required for answer and revise_protocol.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "create") {
      if (!value.goal) context.addIssue({ code: "custom", path: ["goal"], message: "create requires a research goal" })
      if (value.projectID || value.answers)
        context.addIssue({
          code: "custom",
          message: "create accepts a goal and optional target, not a project or answers",
        })
      return
    }
    if (!value.projectID)
      context.addIssue({
        code: "custom",
        path: ["projectID"],
        message: "Provide this conversation's existing project ID",
      })
    if (value.goal || value.target) context.addIssue({ code: "custom", message: "Only create accepts goal and target" })
    const needsAnswers = value.action === "answer" || value.action === "revise_protocol"
    if (needsAnswers && !value.answers)
      context.addIssue({ code: "custom", path: ["answers"], message: "Relay the user's answer or requested changes" })
    if (!needsAnswers && value.answers)
      context.addIssue({ code: "custom", path: ["answers"], message: "This action does not accept answers" })
  })

type Metadata = {
  action: z.infer<typeof MaterialsWorkflowParameters>["action"]
  materialsProjectID: string
  materialsStatus: MaterialProject["status"]
  truncated: false
}
const statuses: Record<MaterialProject["status"], string> = {
  draft: "待启动",
  queued: "等待执行",
  running: "执行中",
  needs_input: "需要补充信息",
  awaiting_approval: "等待人工选择或确认",
  awaiting_data: "等待实验数据",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "执行中断",
}

function summary(project: MaterialProject) {
  const latest = project.artifacts.at(-1)
  return [
    `课题：${project.title.slice(0, 180)}`,
    `项目编号：${project.id}`,
    `状态：${statuses[project.status]}`,
    ...(project.error ? [`说明：${project.error.slice(0, 800)}`] : []),
    ...(project.questions.length
      ? ["需要用户补充：", ...project.questions.map((question) => `- ${question.slice(0, 500)}`)]
      : []),
    ...(latest
      ? [`最新成果：${latest.title.slice(0, 180)}（第 ${latest.version} 版）`, latest.markdown.slice(0, 1800)]
      : []),
    "本会话中的科研卡片会持续更新进度、文献证据与成果；后台任务独立运行，不需要轮询，也不需要打开独立工作台。",
    ...(project.status === "awaiting_approval"
      ? ["请由用户在本会话卡片中选择通过评审的创新方案，或确认最新实验方案；不要替用户批准。"]
      : []),
    ...(project.status === "awaiting_data" ? ["请用户完成线下实验后，在本会话卡片中上传实际测量数据并启动分析。"] : []),
  ].join("\n")
}

export function createMaterialsWorkflowTool(getService: () => Promise<MaterialsService> = materialsService) {
  return Tool.define<typeof MaterialsWorkflowParameters, Metadata>("materials_workflow", async (initCtx) => ({
    description: DESCRIPTION,
    parameters: MaterialsWorkflowParameters,
    async execute(input, ctx) {
      ctx.abort.throwIfAborted()
      const service = await getService()
      const current = input.action === "create" ? undefined : service.get(input.projectID!)
      if (current && current.sessionID !== ctx.sessionID)
        throw new MaterialError(404, "当前会话中不存在该科研课题，请使用本会话卡片里的项目编号")
      if (input.action !== "status") {
        await ctx.ask({
          permission: "materials_workflow",
          patterns: [`${ctx.sessionID}:${current?.id ?? "new"}:${input.action}`],
          always: [`${ctx.sessionID}:*`],
          metadata: { action: input.action, projectID: current?.id, goal: input.goal, target: input.target },
        })
      }
      ctx.abort.throwIfAborted()
      const project = (() => {
        if (input.action === "create") {
          const requestID = `conversation:${createHash("sha256")
            .update(JSON.stringify([ctx.sessionID, ctx.messageID]))
            .digest("hex")}`
          return service.create(
            { goal: input.goal!, target: input.target ?? "auto", requestID, model: initCtx?.model },
            { sessionID: ctx.sessionID },
          )
        }
        if (input.action === "status") return current!
        const latest = service.get(current!.id)
        return service.decide(latest.id, { action: input.action, revision: latest.revision, answers: input.answers })
      })()
      const metadata: Metadata = {
        action: input.action,
        materialsProjectID: project.id,
        materialsStatus: project.status,
        truncated: false,
      }
      const title = `材料科研 · ${statuses[project.status]}`
      ctx.metadata({ title, metadata })
      return { title, metadata, output: summary(project) }
    },
  }))
}

export const MaterialsWorkflowTool = createMaterialsWorkflowTool()
