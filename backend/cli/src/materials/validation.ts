import z from "zod"
import {
  MaterialAnalysis,
  MaterialEvidence,
  MaterialIdeas,
  MaterialIntake,
  MaterialProtocol,
  MaterialStrategies,
  type MaterialProject,
  type MaterialStage,
} from "@synsci/util/materials"

export const tuningDimensions = [
  "Composition tuning",
  "Grain boundary tuning",
  "Interface tuning",
  "Texture tuning",
  "Stress tuning",
] as const

const evidence = MaterialEvidence.strict()
const node = MaterialStrategies.shape.nodes.element
const record = node.shape.records.element.extend({ dimension: z.enum(tuningDimensions), evidence }).strict()
const limitation = node.shape.limitations.element.extend({ evidence }).strict()
const strategies = MaterialStrategies.extend({
  nodes: node
    .extend({ records: record.array().min(1), limitations: limitation.array() })
    .strict()
    .array()
    .min(1),
  edges: MaterialStrategies.shape.edges.element.strict().array(),
}).strict()
const ideas = MaterialIdeas.extend({
  ideas: MaterialIdeas.shape.ideas.element
    .extend({
      evidence: evidence.array().min(1),
      review: MaterialIdeas.shape.ideas.element.shape.review.strict(),
    })
    .strict()
    .array()
    .min(1)
    .max(12),
}).strict()
const protocol = MaterialProtocol.extend({
  groups: MaterialProtocol.shape.groups.element.strict().array().min(1),
  steps: MaterialProtocol.shape.steps.element.strict().array().min(1),
  parameters: MaterialProtocol.shape.parameters.element.extend({ evidence: evidence.array() }).strict().array(),
}).strict()

export const outputSchemas = {
  intake: MaterialIntake.extend({ questions: MaterialIntake.shape.questions.max(2) }).strict(),
  literature: z
    .object({ summary: z.string().min(1), sourceIDs: z.array(z.string()).min(1), gaps: z.array(z.string()) })
    .strict(),
  strategies,
  ideas,
  protocol,
  analysis: MaterialAnalysis.strict(),
} as const

export class MaterialValidationError extends Error {
  constructor(message: string) {
    super(`科研结果校验失败：${message}`)
    this.name = "MaterialValidationError"
  }
}

function fail(message: string): never {
  throw new MaterialValidationError(message)
}

function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issue = result.error.issues[0]
    fail(`${label}的 ${issue.path.join(".") || "根对象"} 格式不正确（${issue.message}）。请按约定结构返回完整 JSON。`)
  }
  return result.data
}

function unique(ids: string[], label: string) {
  const seen = new Set<string>()
  for (const id of ids) {
    if (!id.trim() || id !== id.trim()) fail(`${label}编号不能为空或带首尾空格。`)
    if (seen.has(id)) fail(`${label}编号 ${id} 重复。`)
    seen.add(id)
  }
}

/** Normalize typography and whitespace, while retaining words, numbers and punctuation. */
export function normalizeQuote(text: string) {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim()
}

function source(project: MaterialProject, id: string) {
  const matches = project.sources.filter((item) => item.id === id)
  if (matches.length !== 1) fail(`来源 ${id} 不存在或编号重复，请使用项目中实际保存的文献。`)
  return matches[0]
}

function citation(project: MaterialProject, item: z.infer<typeof MaterialEvidence>, context: string) {
  const paper = source(project, item.sourceID)
  if (paper.kind === "note") fail(`${context}引用了个人笔记 ${paper.id}，笔记不能代替论文证据。`)
  const quote = normalizeQuote(item.quote)
  if (quote.length < 12) fail(`${context}的引用过短，需要至少 12 个字符的原文证据。`)
  if (!normalizeQuote(paper.text).includes(quote)) {
    fail(`${context}的引文不在来源 ${paper.id} 的保存原文中；请逐字引用，不能改写、拼接或虚构。`)
  }
  if (paper.chunks?.length) {
    const matches = paper.chunks.filter((chunk) => chunk.id === item.chunkID)
    if (matches.length !== 1) fail(`${context}必须用 chunkID 指向来源 ${paper.id} 中实际存在且唯一的证据片段。`)
    const chunk = matches[0]
    if (!normalizeQuote(chunk.text).includes(quote)) {
      fail(`${context}的引文不在证据片段 ${chunk.id} 中，不能引用其他片段或跨片段拼接。`)
    }
    if (item.page !== undefined && item.page !== chunk.page) {
      fail(`${context}的页码与证据片段 ${chunk.id} 的实际页码不符；未记录页码时不能自行补写。`)
    }
    return
  }
  if (item.chunkID !== undefined) fail(`${context}引用了未保存的证据片段 ${item.chunkID}。`)
  if (item.page === undefined) return
  // Older browser PDF uploads retain page boundaries in the text instead of structured chunks.
  const pages = [...paper.text.matchAll(/^\[(?:Page\s+|p\.)(\d+)\][ \t]*\r?$/gim)]
  const verified = pages.some((page, index) => {
    if (Number(page[1]) !== item.page) return false
    const text = paper.text.slice(page.index + page[0].length, pages[index + 1]?.index)
    return normalizeQuote(text).includes(quote)
  })
  if (!verified) fail(`${context}的页码没有与该引文对应的已保存分页证据；请核对页码或省略 page。`)
}

function evidenceGap(paper: MaterialProject["sources"][number], gaps: string[]) {
  if (paper.kind === "abstract" && !gaps.some((gap) => gap.includes(paper.id) && /摘要|abstract/i.test(gap))) {
    fail(`来源 ${paper.id} 只有摘要，必须在证据缺口中写明该来源编号及摘要证据限制。`)
  }
  if (
    (paper.kind === "partial" || paper.retrieval?.status === "partial") &&
    !gaps.some((gap) => gap.includes(paper.id) && /部分|不完整|未完整|缺页|partial|incomplete/i.test(gap))
  ) {
    fail(`来源 ${paper.id} 仅有部分正文，必须在证据缺口中写明该来源编号及正文不完整的限制。`)
  }
}

function latest(project: MaterialProject, stage: MaterialStage) {
  const artifact = project.artifacts.findLast((item) => item.stage === stage)
  if (!artifact) fail(`缺少已保存的${stage === "strategies" ? "策略树" : "创新方案"}，请先完成前一阶段。`)
  // Host-authored metadata is outside the model's strict scientific schema.
  const { execution: _execution, statistics: _statistics, skillExecution: _skills, ...data } = artifact.data
  return data
}

function validateStrategies(data: unknown, project: MaterialProject) {
  const value = parse(strategies, data, "策略树")
  unique(
    value.nodes.map((item) => item.id),
    "论文节点",
  )
  unique(
    value.nodes.map((item) => item.sourceID),
    "论文来源（一文一节点）",
  )
  unique(
    value.nodes.flatMap((item) => item.records.map((entry) => entry.id)),
    "策略记录",
  )
  unique(
    value.nodes.flatMap((item) => item.limitations.map((entry) => entry.id)),
    "局限记录",
  )
  unique(
    value.nodes.flatMap((item) => [
      item.id,
      ...item.records.map((entry) => entry.id),
      ...item.limitations.map((entry) => entry.id),
    ]),
    "节点/记录",
  )
  const papers = new Set<string>()
  for (const item of value.nodes) {
    const paper = source(project, item.sourceID)
    if (paper.kind === "note") fail(`节点 ${item.id} 使用了笔记，论文节点必须对应真实文献。`)
    const identity =
      paper.doi
        ?.trim()
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        .toLowerCase() || normalizeQuote(paper.title).toLowerCase()
    if (papers.has(identity)) fail(`节点 ${item.id} 的论文已出现；同一 DOI 或标题不能拆成多个节点。`)
    papers.add(identity)
    evidenceGap(paper, value.coverageGaps)
    for (const entry of [...item.records, ...item.limitations]) {
      if (entry.evidence.sourceID !== item.sourceID)
        fail(`记录 ${entry.id} 的证据必须来自所在节点的论文 ${item.sourceID}。`)
      citation(project, entry.evidence, `记录 ${entry.id}`)
    }
  }
  const nodes = new Map(value.nodes.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const outgoing = new Map(value.nodes.map((item) => [item.id, [] as string[]]))
  const indegree = new Map(value.nodes.map((item) => [item.id, 0]))
  for (const edge of value.edges) {
    const parent = nodes.get(edge.parentID)
    if (!parent || !nodes.has(edge.childID)) fail(`边 ${edge.parentID} → ${edge.childID} 引用了不存在的论文节点。`)
    if (edge.parentID === edge.childID) fail(`节点 ${edge.parentID} 不能连接自己。`)
    if (!parent.limitations.some((item) => item.id === edge.limitationID)) {
      fail(`边 ${edge.parentID} → ${edge.childID} 的局限 ${edge.limitationID} 不属于父节点。`)
    }
    const key = JSON.stringify([edge.parentID, edge.limitationID, edge.childID])
    if (seen.has(key)) fail(`边 ${edge.parentID} → ${edge.childID} 重复。`)
    seen.add(key)
    outgoing.get(edge.parentID)!.push(edge.childID)
    indegree.set(edge.childID, indegree.get(edge.childID)! + 1)
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
  const visited = new Set<string>()
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]
    visited.add(id)
    for (const child of outgoing.get(id)!) {
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) ready.push(child)
    }
  }
  if (visited.size !== value.nodes.length) fail("策略树存在循环；扩展关系必须从父局限指向后续论文，不能回到祖先节点。")
  return value
}

function validateIdeas(data: unknown, project: MaterialProject) {
  const value = parse(ideas, data, "创新方案")
  const tree = validateStrategies(latest(project, "strategies"), project)
  const records = new Map(tree.nodes.flatMap((item) => item.records.map((entry) => [entry.id, item.sourceID] as const)))
  unique(
    value.ideas.map((item) => item.id),
    "创新方案",
  )
  unique(
    value.ideas.map((item) => String(item.rank)),
    "排序",
  )
  for (const idea of value.ideas) {
    unique(idea.strategyIDs, `方案 ${idea.id} 的策略引用`)
    for (const id of idea.strategyIDs) {
      if (!records.has(id)) fail(`方案 ${idea.id} 引用了不存在的策略记录 ${id}；strategyIDs 必须使用记录编号。`)
    }
    const referenced = new Set(idea.strategyIDs.map((id) => records.get(id)!))
    for (const item of idea.evidence) {
      citation(project, item, `方案 ${idea.id}`)
    }
    for (const id of referenced) {
      if (!idea.evidence.some((item) => item.sourceID === id))
        fail(`方案 ${idea.id} 缺少引用策略来源 ${id} 的原文证据。`)
    }
  }
  const accepted = value.ideas.filter((item) => item.review.decision === "accept")
  if (
    accepted.some((item) => value.ideas.some((other) => other.review.decision !== "accept" && other.rank < item.rank))
  ) {
    fail("需修改或已否决的方案不能排在通过审查的方案之前。")
  }
  return value
}

function validateProtocol(data: unknown, project: MaterialProject) {
  const value = parse(protocol, data, "实验方案")
  const candidates = validateIdeas(latest(project, "ideas"), project)
  if (!project.selectedIdeaIDs.length) fail("请先由用户选择创新方案，再生成实验方案。")
  unique(value.ideaIDs, "实验方案的创新引用")
  for (const id of value.ideaIDs) {
    const idea = candidates.ideas.find((item) => item.id === id)
    if (!idea || idea.review.decision !== "accept") fail(`创新方案 ${id} 尚未通过审查，不能用于实验方案。`)
    if (!project.selectedIdeaIDs.includes(id)) fail(`创新方案 ${id} 未被用户选择。`)
  }
  unique(
    value.groups.map((item) => item.id),
    "实验组",
  )
  unique(
    value.steps.map((item) => String(item.order)),
    "步骤顺序",
  )
  if (value.steps.some((item, index) => item.order !== index + 1)) fail("实验步骤必须按从 1 开始的连续顺序排列。")
  for (const item of value.parameters) {
    if (item.basis === "literature" && !item.evidence.length) fail(`参数“${item.name}”标为文献值，却没有原文证据。`)
    for (const entry of item.evidence) citation(project, entry, `参数“${item.name}”`)
  }
  if (!value.confirmations.some((item) => /人工|研究人员|实验人员|负责人|human|researcher/i.test(item))) {
    fail("实验方案必须在 confirmations 中列出实验前由研究人员人工确认的事项。")
  }
  return value
}

export function validateOutput(stage: MaterialStage, data: unknown, project: MaterialProject): Record<string, unknown> {
  if (stage === "strategies") return validateStrategies(data, project)
  if (stage === "ideas") return validateIdeas(data, project)
  if (stage === "protocol") return validateProtocol(data, project)
  if (stage === "literature") {
    const value = parse(outputSchemas.literature, data, "文献综述")
    unique(value.sourceIDs, "综述来源")
    for (const id of value.sourceIDs) {
      const paper = source(project, id)
      if (paper.kind === "note") fail(`综述来源 ${id} 为个人笔记，不能列为论文。`)
      evidenceGap(paper, value.gaps)
    }
    return value
  }
  if (stage === "intake") return parse(outputSchemas.intake, data, "课题需求")
  if (!project.batches.length) fail("尚未回填实验数据，不能生成实验结果分析。")
  return parse(outputSchemas.analysis, data, "数据分析")
}
