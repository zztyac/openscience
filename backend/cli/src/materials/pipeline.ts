import { mkdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { APICallError, stepCountIs, streamText, type LanguageModel, type ToolSet } from "ai"
import { mergeDeep } from "remeda"
import {
  MaterialIntake,
  MaterialStrategies,
  MaterialIdeas,
  MaterialProtocol,
  MaterialAnalysis,
  type MaterialProject,
  type MaterialReporter,
  type MaterialStage,
} from "@synsci/util/materials"
import { Provider } from "../provider/provider"
import { ProviderTransform } from "../provider/transform"
import { Token } from "../util/token"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { collectLiterature } from "./literature"
import { systemPrompt, buildPrompt } from "./domain"
import { validateOutput } from "./validation"
import { computeStatistics } from "./statistics"
import { renderMaterial } from "./render"
import { MaterialError } from "./store"
import type { StageExecutor } from "./workflow"
import { createMaterialSkillExecutor, type MaterialSkillExecutor } from "./skills"

const titles: Record<MaterialStage, string> = {
  intake: "研究目标与任务范围",
  literature: "文献与证据库",
  strategies: "文献策略树",
  ideas: "创新方案与评审",
  protocol: "实验方案草案",
  analysis: "实验结果与下一轮建议",
}

export function parseMaterialJSON(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new MaterialError(422, "模型未返回有效的研究结果 JSON，请重试当前阶段。")
  }
}

export function validateIdeaTransition(before: unknown, after: unknown, mode: "review" | "ranking" | "evolution") {
  const previous = MaterialIdeas.parse(before)
  const next = MaterialIdeas.parse(after)
  const scientific = ({ review: _review, rank: _rank, ...idea }: (typeof previous.ideas)[number]) => idea
  const nextByID = new Map(next.ideas.map((idea) => [idea.id, idea]))
  for (const idea of previous.ideas) {
    const candidate = nextByID.get(idea.id)
    if (!candidate || !isDeepStrictEqual(scientific(idea), scientific(candidate))) {
      throw new Error(`方案 ${idea.id} 的科学内容或 ID 被覆盖。保留已有方案；实质改变的设计只能在演化轮以新 ID 添加。`)
    }
    if (mode !== "review" && !isDeepStrictEqual(idea.review, candidate.review)) {
      throw new Error(`方案 ${idea.id} 的评审结论被非评审角色修改。排序与演化必须保留已有评审。`)
    }
  }
  const previousIDs = new Set(previous.ideas.map((idea) => idea.id))
  for (const idea of next.ideas.filter((idea) => !previousIDs.has(idea.id))) {
    if (mode !== "evolution") throw new Error("评审与排序不能添加新设计；新设计必须经过演化与下一轮独立评审。")
    if (idea.review.decision !== "revise") throw new Error(`演化的新方案 ${idea.id} 必须标记 revise，等待独立评审。`)
  }
}

export type MaterialGenerate = (input: {
  project: MaterialProject
  stage: MaterialStage
  prompt: string
  signal: AbortSignal
  role: string
  report?: MaterialReporter
  tools?: ToolSet
  maxSteps?: number
}) => Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number; finishReason?: string }>

/** Bound the fully assembled prompt, including repair history and candidate review data. */
export function materialRequestBudget(prompt: string, limit: { context: number; input?: number; output: number }) {
  const context = Number.isFinite(limit.context) && limit.context > 0 ? limit.context : 128_000
  const output = Number.isFinite(limit.output) && limit.output > 0 ? limit.output : 12_000
  const maxOutputTokens = Math.min(output, 12_000, Math.floor(context / 2))
  const available = Math.min(limit.input && limit.input > 0 ? limit.input : context, context - maxOutputTokens)
  if (prompt.length > 400_000 || Token.estimate(systemPrompt + prompt) + 512 > available) {
    throw new MaterialError(
      422,
      "本轮科研资料超过所选模型的输入范围。请使用更长上下文的模型，或新建范围更小的课题并分批分析实验数据。",
    )
  }
  return { maxOutputTokens }
}

export function materialProviderOptions(
  model: Provider.Model,
  providerOptions: Record<string, unknown>,
  sessionID: string,
) {
  const defaults = ProviderTransform.options({ model, sessionID, providerOptions })
  // Use the same precedence as the conversation model: explicit model settings win.
  return ProviderTransform.providerOptions(model, mergeDeep(defaults, model.options))
}

/** Consume the same streaming transport as Research, then validate the complete stage output. */
export async function streamMaterialModel(
  model: LanguageModel,
  prompt: string,
  maxOutputTokens: number,
  signal: AbortSignal,
  providerOptions: ReturnType<typeof materialProviderOptions> = {},
  report?: MaterialReporter,
  execution?: { tools?: ToolSet; maxSteps?: number; maxInputTokens?: number },
) {
  signal.throwIfAborted()
  const failure: { error?: unknown } = {}
  let outputChars = 0
  const failed = (error: unknown): never => {
    const cause = signal.aborted ? signal.reason : (failure.error ?? error)
    if (Provider.isRequestTimeoutError(cause))
      throw new MaterialError(503, "模型接口或网络连接超时，已保留此前完成的科研成果，请稍后继续当前阶段。")
    signal.throwIfAborted()
    if (APICallError.isInstance(cause) && [502, 503, 504].includes(cause.statusCode ?? 0))
      throw new MaterialError(503, "模型网关暂时不可用或响应超时，已保留此前完成的科研成果，请稍后继续当前阶段。")
    throw cause
  }
  const result = streamText({
    model,
    system: systemPrompt,
    prompt,
    tools: execution?.tools,
    ...(execution?.tools ? { stopWhen: stepCountIs(execution.maxSteps ?? 12) } : {}),
    ...(execution?.tools
      ? {
          prepareStep: ({ messages }: { messages: import("ai").ModelMessage[] }) => {
            const retained = [...messages]
            const budget = execution.maxInputTokens ?? 90_000
            // Keep complete assistant/tool pairs. Retrieved evidence lives in the stage store,
            // so discarded retrieval history can be read again through get_evidence.
            while (Token.estimate(JSON.stringify(retained)) + 2500 > budget) {
              const first = retained.findIndex((message) => message.role === "assistant")
              const next = retained.findIndex((message, index) => index > first && message.role === "assistant")
              if (first < 0 || next < 0)
                throw new MaterialError(422, "Skill 工具结果超过所选模型的上下文范围，已保留取得的证据")
              retained.splice(first, next - first)
            }
            return { messages: retained }
          },
        }
      : {}),
    maxOutputTokens,
    providerOptions,
    maxRetries: 0,
    abortSignal: signal,
    // The SDK's default logger prints raw provider errors, which may contain credentials.
    onError: ({ error }) => {
      failure.error = error
    },
    onChunk: ({ chunk }) => {
      if (signal.aborted) return
      if (chunk.type === "reasoning-delta") report?.({ phase: "reasoning", outputChars })
      if (chunk.type === "text-delta") {
        outputChars += chunk.text.length
        report?.({ phase: "generating", outputChars })
      }
    },
    experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
  })
  // Some SDK abort paths never settle text/usage when no text has arrived.
  // Race cancellation explicitly so a stopped task releases its worker slot.
  const cancelled = Promise.withResolvers<never>()
  const cancel = () => cancelled.reject(signal.reason)
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()
  const complete = await Promise.race([
    Promise.all([result.text, result.finishReason, result.totalUsage]),
    cancelled.promise,
  ])
    .catch(failed)
    .finally(() => signal.removeEventListener("abort", cancel))
  if (signal.aborted || failure.error) failed(failure.error)
  if (complete[1] !== "stop" && complete[1] !== "length" && !(execution?.tools && complete[1] === "tool-calls")) {
    throw new MaterialError(503, "模型流式响应未正常结束，本轮结果尚未保存。请稍后继续当前阶段。")
  }
  return { text: complete[0], finishReason: complete[1], usage: complete[2] }
}

export const generateMaterial: MaterialGenerate = async (input) => {
  const report: MaterialReporter | undefined = input.report
    ? (update) => input.report?.({ ...update, role: input.role })
    : undefined
  const directory = path.join(Global.Path.data, "materials", "runtime")
  await mkdir(directory, { recursive: true })
  return Instance.provide({
    directory,
    fn: async () => {
      const selected = input.project.model ?? (await Provider.defaultModel())
      const model = await Provider.getModel(selected.providerID, selected.modelID)
      input.signal.throwIfAborted()
      report?.({
        phase: input.role.endsWith(":repair") ? "repairing" : "preparing",
        model: `${selected.providerID}/${selected.modelID}`,
      })
      const provider = await Provider.getProvider(selected.providerID)
      const budget = materialRequestBudget(input.prompt, model.limit)
      const context = Number.isFinite(model.limit.context) && model.limit.context > 0 ? model.limit.context : 128_000
      const language = await Provider.getLanguage(model)
      const sessionID = `materials:${input.project.id}`
      const options = materialProviderOptions(model, provider.options, sessionID)
      // Research calls may reason silently for a long time; only the caller
      // controls cancellation, including user Stop and service shutdown.
      const signal = input.signal
      const result = await Provider.withRequestContext(
        {
          sessionID,
          messageID: `materials:${crypto.randomUUID()}`,
          attempt: 1,
          agent: input.role,
          modelID: selected.modelID,
          timeouts: false,
          abort: signal,
          onRequest: () => report?.({ phase: "waiting" }),
        },
        () =>
          streamMaterialModel(language, input.prompt, budget.maxOutputTokens, signal, options, report, {
            ...input,
            maxInputTokens:
              Math.min(
                model.limit.input && model.limit.input > 0 ? model.limit.input : context,
                context - budget.maxOutputTokens,
              ) - 512,
          }),
      )
      if (result.finishReason === "length")
        throw new MaterialError(422, "模型输出超过长度限制；请缩小课题范围或减少文献后重试。")
      return {
        text: result.text,
        model: `${selected.providerID}/${selected.modelID}`,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        finishReason: result.finishReason,
      }
    },
  })
}

export function createMaterialExecutor(
  dependencies: {
    generate?: MaterialGenerate
    search?: typeof collectLiterature
    skills?: MaterialSkillExecutor | false
  } = {},
): StageExecutor {
  const generate = dependencies.generate ?? generateMaterial
  const search = dependencies.search ?? collectLiterature
  const skills =
    dependencies.skills === false ? undefined : (dependencies.skills ?? createMaterialSkillExecutor({ generate }))
  return async (input, stage, signal, report) => {
    signal.throwIfAborted()
    const found =
      stage === "literature"
        ? await search(input, signal, undefined, undefined, report)
        : { sources: input.sources, gaps: [] }
    const result = skills
      ? await skills({ ...input, sources: found.sources }, stage, signal, report)
      : { sources: found.sources }
    const project = { ...input, sources: result.sources }
    const metadata = result.execution ? { skillExecution: result.execution } : {}
    if (stage === "literature") {
      const scientific = project.sources.filter((source) => source.kind !== "note")
      if (!scientific.length)
        throw new MaterialError(
          422,
          `暂未获取可引用的文献证据。${found.gaps.slice(0, 3).join(" ")} 请在文献页上传论文 PDF/文本或粘贴摘要，然后点击继续。`,
        )
      report?.({ phase: "validating" })
      const data = validateOutput(
        stage,
        {
          summary: `本轮共整理 ${scientific.length} 篇可引用资料：全文 ${scientific.filter((source) => source.kind === "fulltext").length} 篇、部分正文 ${scientific.filter((source) => source.kind === "partial").length} 篇、仅摘要 ${scientific.filter((source) => source.kind === "abstract").length} 篇。已提取 ${scientific.reduce((sum, source) => sum + (source.chunks?.length ?? 0), 0)} 个可追溯正文片段。全文获取与提取不等于已完成全文审查；相关性和结论支持程度将在策略构建与评审阶段检查。`,
          sourceIDs: scientific.map((source) => source.id),
          gaps: [
            ...found.gaps.filter((gap) => !found.sources.some((source) => gap.startsWith(`${source.id}（`))),
            ...scientific
              .filter((source) => source.kind === "abstract" || source.kind === "partial")
              .map(
                (source) =>
                  `${source.id}（${source.title}）：${source.kind === "partial" ? "仅取得部分正文" : "目前只有摘要"}。${source.retrieval?.reason ?? ""}不能据此声称已完成全文审查；精确工艺参数必须有实际原文支持。`,
              ),
            ...(result.execution?.warnings ?? []),
          ],
        },
        project,
      )
      return {
        title: titles[stage],
        data: { ...data, ...metadata },
        markdown: renderMaterial(stage, data),
        sources: project.sources,
      }
    }
    const statistics =
      stage === "analysis"
        ? computeStatistics(project.batches.filter((batch) => batch.protocolID === project.approvedProtocolID))
        : undefined
    const prompt = buildPrompt(stage, project)
    const execution: Array<{ role: string; model: string; inputTokens?: number; outputTokens?: number }> = []
    const steps = stage === "ideas" ? 5 : stage === "strategies" || stage === "protocol" ? 2 : 1
    let requested = 0
    async function request(role: string, instructions: string, check?: (data: unknown) => void) {
      signal.throwIfAborted()
      const step = ++requested
      const progress =
        (name: string): MaterialReporter =>
        (update) =>
          report?.({ ...update, role: name, step, steps })
      const update = progress(role)
      update({ phase: "preparing", outputChars: 0 })
      const validate = (text: string) => {
        const data = validateOutput(stage, parseMaterialJSON(text), project)
        check?.(data)
        return data
      }
      const result = await generate({ project, stage, prompt: instructions, signal, role, report: update })
      execution.push({ role, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens })
      signal.throwIfAborted()
      update({ phase: "validating", model: result.model })
      try {
        return validate(result.text)
      } catch (error) {
        const reason = error instanceof Error ? error.message : "结果未通过校验"
        const retry = progress(`${role}:repair`)
        retry({ phase: "repairing", outputChars: 0 })
        const repair = await generate({
          project,
          stage,
          signal,
          role: `${role}:repair`,
          report: retry,
          prompt: `${instructions}\n\n上一次结果未通过确定性校验：${reason.slice(0, 3000)}\n请修复这些问题，完整重写结果。上次结果：\n${result.text.slice(0, 80_000)}`,
        })
        execution.push({
          role: `${role}:repair`,
          model: repair.model,
          inputTokens: repair.inputTokens,
          outputTokens: repair.outputTokens,
        })
        signal.throwIfAborted()
        retry({ phase: "validating", model: repair.model })
        try {
          return validate(repair.text)
        } catch {
          throw new MaterialError(422, `研究结果未通过证据或结构校验：${reason.slice(0, 800)}。可补充资料后重试。`)
        }
      }
    }
    const draft = await request(
      stage === "strategies" ? "strategy-builder" : stage === "ideas" ? "idea-expert" : stage,
      prompt,
    )
    const data =
      stage === "strategies" || stage === "ideas" || stage === "protocol"
        ? await request(
            `${stage}:reviewer`,
            `${prompt}\n\n你现在承担独立评审角色。下面是另一轮生成的候选结果，不是可信结论。逐项重新核对引用原文、科学推断边界和物理可行性。${stage === "ideas" ? "评审每个候选并给出accept/revise/reject，仅修改review、rank与comparison，所有科学字段和ID逐字保留。此轮不演化新设计。缺乏充分支持时必须保留revise/reject，不为完成任务强行接受。" : "删除虚构引用，修订过度结论，保留证据缺口和待人工确认项。"}\n输出同一 Schema 的完整修订对象，所有引用仍需可验证。\n\n候选结果：\n${JSON.stringify(draft)}`,
            stage === "ideas" ? (value) => validateIdeaTransition(draft, value, "review") : undefined,
          )
        : draft
    const revised =
      stage === "ideas"
        ? await (async () => {
            const ranked = await request(
              "idea-proximity-ranking",
              `${prompt}\n\n当前角色：相似度分析与排序。基于以下独立评审结果，比较方案重复性、科学空白和可检验性，完善comparison并排序。保留每个方案的科学内容与评审决定；accept优先，rank唯一。\n${JSON.stringify(data)}`,
              (value) => validateIdeaTransition(data, value, "ranking"),
            )
            const evolved = MaterialIdeas.parse(
              await request(
                "idea-evolution",
                `${prompt}\n\n当前角色：候选演化。根据以下评审与排序进行一轮有依据的改进。逐字保留所有已有方案的科学字段、ID及review，仅可调整rank。实质改变设计只能额外添加使用新ID的候选，并在comparison记录父ID及修改原因；新方案必须标review.decision=revise，等待下一轮独立审查。若没有合理改进，保留现有候选并解释。不得制造新证据。\n${JSON.stringify(ranked)}`,
                (value) => validateIdeaTransition(ranked, value, "evolution"),
              ),
            )
            return request(
              "idea-final-review",
              `${prompt}\n\n当前角色：演化后的独立最终评审。逐项重新审核下面的方案，对改动内容、引用、物理可行性、创新和风险进行审查；不能沿用生成者的自我判定。给出真实accept/revise/reject，最终按accept优先重排唯一rank，更新comparison。仅能修改review、rank、comparison，所有科学字段和ID逐字保留，不可在此轮自行改设计后立即接受。输出完整对象。\n${JSON.stringify(evolved)}`,
              (value) => validateIdeaTransition(evolved, value, "review"),
            )
          })()
        : data
    const final = { ...revised, execution, ...metadata, ...(statistics ? { statistics } : {}) }
    return {
      title: titles[stage],
      data: final,
      markdown: renderMaterial(stage, final),
      sources: project.sources,
      ...(stage === "intake"
        ? { questions: MaterialIntake.parse(data).questions, target: MaterialIntake.parse(data).target }
        : {}),
    }
  }
}

export const executeStage: StageExecutor = createMaterialExecutor()
