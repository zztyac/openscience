import path from "node:path"
import { AsyncResource } from "node:async_hooks"
import z from "zod"
import {
  MaterialAnalysis,
  MaterialBatchInput,
  MaterialCreate,
  MaterialDecision,
  MaterialIdeas,
  MaterialIntake,
  type MaterialLibrarySnapshot,
  MaterialProject,
  MaterialProtocol,
  MaterialSource,
  MaterialSourceInput,
  MaterialSkillExecution,
  MaterialStage,
  MaterialStrategies,
  MaterialTarget,
  type MaterialReporter,
} from "@synsci/util/materials"
import { MaterialsStore, MaterialError, materialEvent, materialID, type MaterialBinding } from "./store"
import { computeStatistics } from "./statistics"
import { materialActivity } from "./activity"

export type StageResult = {
  data: Record<string, unknown>
  markdown: string
  title: string
  sources?: MaterialSource[]
  questions?: string[]
  target?: z.infer<typeof MaterialTarget>
}
export type StageExecutor = (
  project: MaterialProject,
  stage: MaterialStage,
  signal: AbortSignal,
  report?: MaterialReporter,
) => Promise<StageResult>

const names: Record<MaterialStage, string> = {
  intake: "目标澄清",
  literature: "文献整理",
  strategies: "策略构建",
  ideas: "创新方案",
  protocol: "实验方案",
  analysis: "实验分析",
}

export class MaterialsService {
  readonly store: MaterialsStore
  private active = new Map<string, AbortController>()
  private timer: ReturnType<typeof setInterval>
  private closed = false
  private leader = false
  private concurrency: number
  private libraryPending = new Map<string, MaterialProject>()
  private libraryJobs = new Map<string, Promise<MaterialLibrarySnapshot>>()
  private libraryErrors = new Map<string, MaterialLibrarySnapshot>()

  constructor(
    private options: {
      directory: string
      executor: StageExecutor
      concurrency?: number
      pollInterval?: number
      library?: {
        read: (project: MaterialProject) => Promise<MaterialLibrarySnapshot>
        sync: (project: MaterialProject) => Promise<MaterialLibrarySnapshot>
      }
    },
  ) {
    this.store = new MaterialsStore(options.directory)
    this.concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2))
    this.leader = this.store.acquire()
    this.store.onChange = (project) => {
      if (this.options.library) void this.queueLibrary(project)
    }
    this.timer = setInterval(() => this.pump(), options.pollInterval ?? 500)
    this.timer.unref()
  }

  list() {
    return this.store.list()
  }
  get(id: string) {
    return this.store.get(id)
  }
  activity(id: string) {
    return this.store.activity(id)
  }

  async library(id: string): Promise<MaterialLibrarySnapshot> {
    const project = this.get(id)
    const snapshot = this.libraryErrors.get(id) ??
      (await this.options.library?.read(project)) ?? {
        materialsProjectID: id,
        status: "unbound" as const,
        files: [],
        warnings: [],
        message: "当前课题尚未连接原项目的文件与成果管理",
      }
    if (this.libraryJobs.has(id)) return { ...snapshot, status: "syncing" as const }
    // A process can stop after recording "syncing". Its receipt is recoverable,
    // but a new process must not claim that the previous writer is still active.
    return snapshot.status === "syncing" ? { ...snapshot, status: "pending" as const } : snapshot
  }

  syncLibrary(id: string) {
    const project = this.get(id)
    if (!this.options.library) return this.library(id)
    return this.queueLibrary(project)
  }

  /** Files and Results are recoverable projections; their failure must never fail a research stage. */
  private queueLibrary(project: MaterialProject): Promise<MaterialLibrarySnapshot> {
    this.libraryPending.set(project.id, project)
    const existing = this.libraryJobs.get(project.id)
    if (existing) return existing
    const promise = Promise.resolve().then(async () => {
      let result: MaterialLibrarySnapshot = {
        materialsProjectID: project.id,
        status: "pending",
        files: [],
        warnings: [],
      }
      try {
        while (this.libraryPending.has(project.id)) {
          const next = this.libraryPending.get(project.id)!
          this.libraryPending.delete(project.id)
          this.libraryErrors.delete(project.id)
          try {
            result = await this.options.library!.sync(next)
          } catch {
            result = {
              ...result,
              status: "error",
              message: "文件或成果同步失败；科研记录已保留，可稍后重新同步",
            }
            this.libraryErrors.set(project.id, result)
          }
        }
        return result
      } finally {
        // Remove the worker in the same microtask as its final queue check:
        // a later update must start another worker, not join a resolved one.
        this.libraryJobs.delete(project.id)
      }
    })
    this.libraryJobs.set(project.id, promise)
    return promise
  }

  async flushLibrary() {
    while (this.libraryJobs.size) await Promise.allSettled([...this.libraryJobs.values()])
  }

  create(input: z.input<typeof MaterialCreate>, binding?: MaterialBinding) {
    const result = this.store.create(input, binding)
    queueMicrotask(() => this.pump())
    return result
  }

  source(id: string, input: z.input<typeof MaterialSourceInput>, attachment?: { id: string }) {
    const parsed = MaterialSourceInput.parse(input)
    if (attachment && !/^src_[a-f0-9]{32}$/.test(attachment.id)) throw new MaterialError(400, "文献编号不正确")
    return this.store.update(id, undefined, (project) => {
      if (["running", "queued"].includes(project.status)) throw new MaterialError(409, "请先取消当前任务，再补充文献")
      if (project.artifacts.some((item) => item.stage === "strategies"))
        throw new MaterialError(409, "已生成策略的课题不能修改证据集合，请新建课题使用新的文献")
      if (parsed.url && !["http:", "https:"].includes(new URL(parsed.url).protocol))
        throw new MaterialError(400, "文献链接仅支持 HTTP 或 HTTPS")
      if (
        project.sources.length >= 24 ||
        project.sources.reduce((sum, source) => sum + source.text.length, 0) + parsed.text.length > 1_000_000
      )
        throw new MaterialError(400, "每个课题最多保存 24 份文献，正文总长度不超过 100 万字符")
      const sourceID = attachment?.id ?? materialID("src")
      if (project.sources.some((source) => source.id === sourceID)) throw new MaterialError(409, "文献编号已存在")
      project.sources.push({ ...parsed, id: sourceID, createdAt: Date.now(), origin: "upload" })
      const literature = project.stages.find((item) => item.key === "literature")!
      literature.status = "pending"
      literature.error = undefined
      if (project.status === "completed") project.status = "draft"
      materialEvent(project, `已添加文献：${parsed.title}`)
    })
  }

  batch(id: string, input: z.input<typeof MaterialBatchInput>) {
    const parsed = MaterialBatchInput.parse(input)
    return this.store.update(id, parsed.revision, (project) => {
      if (!["awaiting_data", "completed"].includes(project.status) || !project.approvedProtocolID)
        throw new MaterialError(409, "请先确认实验方案，再回填实验数据")
      if (parsed.protocolID !== project.approvedProtocolID)
        throw new MaterialError(409, "数据必须关联当前已确认的实验方案版本")
      const protocol = MaterialProtocol.parse(
        project.artifacts.find((item) => item.id === project.approvedProtocolID)?.data,
      )
      const groups = new Set(protocol.groups.map((item) => item.id))
      for (const measurement of parsed.measurements) {
        if (!groups.has(measurement.groupID)) throw new MaterialError(400, `实验组不存在：${measurement.groupID}`)
        if (
          /(^j[ _]?c$|临界电流密度|critical current density)/i.test(measurement.property) &&
          (measurement.temperatureK === undefined || measurement.fieldT === undefined)
        )
          throw new MaterialError(400, "Jc 数据必须记录温度 K 和磁场 T，零场测量请填写 0")
      }
      if (project.batches.length >= 100) throw new MaterialError(400, "每个课题最多保存 100 批实验数据")
      const { revision: _, ...batch } = parsed
      project.batches.push({ ...batch, id: materialID("batch"), createdAt: Date.now() })
      project.status = "awaiting_data"
      materialEvent(project, `已保存实验批次：${batch.name}`)
    })
  }

  decide(id: string, input: z.input<typeof MaterialDecision>) {
    const decision = MaterialDecision.parse(input)
    const result = this.store.update(id, decision.revision, (project) => {
      if (decision.action === "cancel") {
        if (!["queued", "running"].includes(project.status)) throw new MaterialError(409, "当前没有正在执行的任务")
        project.status = "cancelled"
        for (const stage of project.stages) if (stage.status === "running") stage.status = "interrupted"
        materialEvent(project, "任务已取消，已完成的成果仍然保留", "decision")
        return
      }
      if (["queued", "running"].includes(project.status)) throw new MaterialError(409, "该课题已经在执行，请等待或取消")
      if (decision.action === "refresh_literature") {
        if (
          project.stages.find((stage) => stage.key === "intake")?.status !== "completed" ||
          project.questions.length ||
          project.artifacts.some((artifact) => artifact.stage === "strategies") ||
          project.approvedProtocolID
        )
          throw new MaterialError(
            409,
            "仅可在目标澄清完成、策略生成之前重新获取全文；已有策略的课题请新建研究以保留证据版本",
          )
        for (const stage of project.stages) {
          if (stage.key === "intake") continue
          stage.status = "pending"
          stage.error = undefined
          stage.startedAt = undefined
          stage.finishedAt = undefined
        }
        materialEvent(project, "重新整理文献并获取开放全文，完成后继续原研究目标", "decision")
      } else if (decision.action === "answer") {
        if (project.status !== "needs_input" || !decision.answers?.trim())
          throw new MaterialError(400, "请填写需要补充的研究条件")
        project.answers = [project.answers, decision.answers.trim()].filter(Boolean).join("\n\n")
        project.questions = []
        project.stages.find((stage) => stage.key === "intake")!.status = "pending"
        materialEvent(project, "已补充研究条件", "decision")
      } else if (decision.action === "select_ideas") {
        const continuing = project.status === "completed" && project.target === "ideas"
        if ((!continuing && project.status !== "awaiting_approval") || this.latest(project, "protocol"))
          throw new MaterialError(409, "当前阶段不接受创新方案选择")
        const ideas = this.latest(project, "ideas")
        if (!ideas) throw new MaterialError(409, "尚未生成创新方案")
        const accepted = MaterialIdeas.parse(ideas.data)
          .ideas.filter((idea) => idea.review.decision === "accept")
          .map((idea) => idea.id)
        if (
          !decision.ideaIDs?.length ||
          new Set(decision.ideaIDs).size !== decision.ideaIDs.length ||
          decision.ideaIDs.some((idea) => !accepted.includes(idea))
        )
          throw new MaterialError(400, "只能选择已通过评审的创新方案")
        project.selectedIdeaIDs = decision.ideaIDs
        project.target = "protocol"
        const protocol = project.stages.find((stage) => stage.key === "protocol")!
        if (protocol.status === "skipped") protocol.status = "pending"
        materialEvent(project, "已选择创新方案，开始生成实验草案", "decision")
      } else if (decision.action === "revise_protocol") {
        if (project.status !== "awaiting_approval" || !this.latest(project, "protocol") || project.approvedProtocolID)
          throw new MaterialError(409, "只有尚未确认的实验方案可以修改")
        if (!decision.answers?.trim()) throw new MaterialError(400, "请填写实验方案修改要求")
        project.answers = [project.answers, `实验方案修改要求：${decision.answers.trim()}`].filter(Boolean).join("\n\n")
        project.stages.find((stage) => stage.key === "protocol")!.status = "pending"
        materialEvent(project, "已记录实验方案修改要求，开始生成新版本", "decision")
      } else if (decision.action === "approve_protocol") {
        const protocol = this.latest(project, "protocol")
        if (project.status !== "awaiting_approval" || !protocol || decision.protocolID !== protocol.id)
          throw new MaterialError(409, "请确认当前实验方案的确切版本")
        project.approvedProtocolID = protocol.id
        project.status = "awaiting_data"
        materialEvent(project, "实验方案已确认，等待人工实验与数据回填", "decision")
        return
      } else if (decision.action === "analyze") {
        if (
          !["awaiting_data", "completed"].includes(project.status) ||
          !project.approvedProtocolID ||
          !project.batches.length
        )
          throw new MaterialError(409, "请确认实验方案并至少回填一批实验数据")
        project.stages.find((stage) => stage.key === "analysis")!.status = "pending"
        materialEvent(project, "开始分析已保存的实验数据", "decision")
      } else {
        if (!["draft", "failed", "cancelled", "interrupted"].includes(project.status))
          throw new MaterialError(409, "当前阶段需要完成指定的确认操作")
        for (const stage of project.stages)
          if (["failed", "interrupted"].includes(stage.status)) stage.status = "pending"
        materialEvent(project, "继续执行未完成的科研阶段", "decision")
      }
      project.status = "queued"
      project.error = undefined
    })
    if (decision.action === "cancel") this.active.get(id)?.abort(new Error("任务已取消"))
    queueMicrotask(() => this.pump())
    return result
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    for (const controller of this.active.values()) controller.abort(new Error("服务已停止"))
    this.store.close()
  }

  private latest(project: MaterialProject, stage: MaterialStage) {
    return project.artifacts.findLast((artifact) => artifact.stage === stage)
  }

  private pump() {
    if (this.closed) return
    this.leader = this.store.acquire()
    if (!this.leader) return
    for (const [id, controller] of this.active)
      if (this.store.get(id).status !== "running") controller.abort(new Error("任务已取消"))
    for (const id of this.store.queued()) {
      if (this.active.size >= this.concurrency) break
      if (this.active.has(id)) continue
      const controller = new AbortController()
      this.active.set(id, controller)
      void this.run(id, controller.signal).finally(() => {
        this.active.delete(id)
        queueMicrotask(() => this.pump())
      })
    }
  }

  private runnable(project: MaterialProject): MaterialStage | undefined {
    if (project.approvedProtocolID) return "analysis"
    return project.stages.find(
      (stage) => stage.key !== "analysis" && stage.status !== "completed" && stage.status !== "skipped",
    )?.key
  }

  private async run(id: string, signal: AbortSignal) {
    let activity: ReturnType<typeof materialActivity> | undefined
    try {
      this.store.update(id, undefined, (project) => {
        if (project.status !== "queued") throw new MaterialError(409, "任务状态已改变")
        project.status = "running"
      })
      while (!this.closed && !signal.aborted) {
        const project = this.store.get(id)
        if (project.status !== "running") return
        const stage = this.runnable(project)
        if (!stage) throw new MaterialError(409, "没有可执行的阶段，请确认当前成果")
        const snapshot = this.store.update(id, project.revision, (next) => {
          const step = next.stages.find((item) => item.key === stage)!
          step.status = "running"
          step.startedAt = Date.now()
          step.finishedAt = undefined
          step.error = undefined
          materialEvent(next, `开始执行${names[stage]}阶段`)
        })
        activity = materialActivity(this.store, id, stage, signal)
        // The executor receives a detached snapshot: later UI requests cannot alter its inputs.
        const result = await this.options.executor(snapshot, stage, signal, activity.report)
        if (this.closed || signal.aborted) return
        activity.report({ phase: "validating" })
        const data = this.validate(stage, result.data, snapshot)
        const latest = this.store.get(id)
        if (latest.status !== "running" || !this.store.owns()) return
        activity.report({ phase: "saving" })
        const saved = this.store.update(id, latest.revision, (next) => {
          if (result.sources) {
            const sources = result.sources.map((source) => MaterialSource.parse(source))
            for (const source of sources) {
              const index = next.sources.findIndex((item) => item.id === source.id)
              const existing = next.sources[index]
              if (existing && JSON.stringify(existing) !== JSON.stringify(source)) {
                const identity = (item: MaterialSource) => [
                  item.title,
                  item.authors,
                  item.doi,
                  item.url,
                  item.year,
                  item.origin,
                  item.createdAt,
                ]
                if (
                  stage !== "literature" ||
                  ["upload", "supramas"].includes(existing.origin) ||
                  next.artifacts.some((artifact) => artifact.stage === "strategies") ||
                  JSON.stringify(identity(existing)) !== JSON.stringify(identity(source))
                )
                  throw new Error("文献来源 ID 冲突")
                next.sources[index] = source
              }
              if (!existing) next.sources.push(source)
            }
            if (
              next.sources.length > 24 ||
              next.sources.reduce((sum, source) => sum + source.text.length, 0) > 1_000_000
            )
              throw new MaterialError(400, "文献超过 24 份或正文总长度超过 100 万字符")
          }
          const inputs =
            stage === "analysis"
              ? [snapshot.approvedProtocolID!, ...snapshot.batches.map((batch) => batch.id)]
              : [...new Set(snapshot.artifacts.map((artifact) => artifact.stage))].map(
                  (key) => this.latest(snapshot, key)!.id,
                )
          const artifact = {
            id: materialID("art"),
            stage,
            version: next.artifacts.filter((item) => item.stage === stage).length + 1,
            title: result.title,
            createdAt: Date.now(),
            markdown: result.markdown,
            data,
            inputArtifactIDs: inputs,
          }
          next.artifacts.push(artifact)
          const step = next.stages.find((item) => item.key === stage)!
          step.status = "completed"
          step.finishedAt = Date.now()
          materialEvent(next, `${names[stage]}阶段已完成`)
          if (stage === "intake") {
            const intake = MaterialIntake.parse(data)
            next.title = intake.title
            if (next.target === "auto" && !intake.questions.length) next.target = intake.target
            next.questions = intake.questions
            if (next.questions.length) next.status = "needs_input"
          }
          if (stage === next.target) {
            next.status = stage === "protocol" ? "awaiting_approval" : "completed"
            if (next.status === "completed")
              for (const item of next.stages) if (item.status === "pending") item.status = "skipped"
          }
          if (stage === "ideas" && next.target === "protocol") {
            if (MaterialIdeas.parse(data).ideas.some((idea) => idea.review.decision === "accept"))
              next.status = "awaiting_approval"
            else {
              next.status = "failed"
              next.error = "当前没有通过评审的创新方案；可重试本阶段，或新建目标更具体的课题"
              step.status = "failed"
              step.error = next.error
              materialEvent(next, next.error, "error")
            }
          }
          if (stage === "analysis") next.status = "completed"
        })
        activity.finish(saved.status === "failed" ? "failed" : "completed")
        if (saved.status !== "running") return
      }
    } catch (error) {
      if (this.closed || signal.aborted) return
      const project = this.store.get(id)
      if (project.status !== "running") return
      activity?.flush()
      // Provider SDK exceptions may contain headers or URLs. Persist only a bounded public message.
      const message = error instanceof MaterialError ? error.message : "该阶段执行失败，请检查模型或文献配置后恢复任务"
      this.store.update(id, project.revision, (next) => {
        next.status = "failed"
        next.error = message
        for (const stage of next.stages)
          if (stage.status === "running") {
            stage.status = "failed"
            stage.error = message
          }
        materialEvent(next, message, "error")
      })
      activity?.finish("failed")
    } finally {
      activity?.dispose()
    }
  }

  private validate(
    stage: MaterialStage,
    data: Record<string, unknown>,
    project: MaterialProject,
  ): Record<string, unknown> {
    const schemas = {
      intake: MaterialIntake,
      strategies: MaterialStrategies,
      ideas: MaterialIdeas,
      protocol: MaterialProtocol,
      analysis: MaterialAnalysis,
    }
    const validated = stage === "literature" ? data : schemas[stage].parse(data)
    const execution =
      data.execution === undefined
        ? undefined
        : z
            .array(
              z.object({
                role: z.string().max(100),
                model: z.string().max(300),
                inputTokens: z.number().nonnegative().optional(),
                outputTokens: z.number().nonnegative().optional(),
              }),
            )
            .max(12)
            .parse(data.execution)
    return {
      ...validated,
      ...(execution ? { execution } : {}),
      ...(data.skillExecution ? { skillExecution: MaterialSkillExecution.parse(data.skillExecution) } : {}),
      ...(stage === "analysis"
        ? {
            statistics: computeStatistics(
              project.batches.filter((batch) => batch.protocolID === project.approvedProtocolID),
            ),
          }
        : {}),
    }
  }
}

const lifecycle = new AsyncResource("materials-service")
let service: MaterialsService | undefined
let initialization: Promise<MaterialsService> | undefined
let operation: import("../global/data-root-barrier").DataRootBarrier.Operation | undefined

export async function materialsService() {
  if (service) return service
  initialization ??= (async () => {
    const [{ Global }, { executeStage }, { DataRootBarrier }, library] = await Promise.all([
      import("../global"),
      import("./pipeline"),
      import("../global/data-root-barrier"),
      import("./library"),
    ])
    const directory = path.join(Global.Path.data, "materials")
    // SQLite connections and background work outlive HTTP requests. Retain a
    // cross-process marker until this runtime closes, so relocation cannot
    // copy a live WAL or strand an open connection on the old data root.
    // Acquire while the HTTP request is still an admitted parent. Starting
    // this enter in a detached context can deadlock against a relocation
    // intent that is waiting for the parent request to finish.
    operation = await DataRootBarrier.enter(directory)
    try {
      service = lifecycle.runInAsyncScope(
        () =>
          new MaterialsService({
            directory,
            executor: executeStage,
            library: { read: library.getMaterialLibrary, sync: library.syncMaterialLibrary },
          }),
      )
      return service
    } catch (error) {
      await operation[Symbol.asyncDispose]()
      operation = undefined
      throw error
    }
  })().catch((error) => {
    initialization = undefined
    throw error
  })
  return initialization
}

/** Called by server lifecycle hooks before relocating or closing the data store. */
export async function disposeMaterialsService() {
  await initialization?.catch(() => undefined)
  service?.close()
  await service?.flushLibrary()
  service = undefined
  initialization = undefined
  const retained = operation
  operation = undefined
  await retained?.[Symbol.asyncDispose]()
}

export function materialsServiceActive() {
  return !!(service || initialization)
}
