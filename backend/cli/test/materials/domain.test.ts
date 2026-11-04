import { describe, expect, test } from "bun:test"
import {
  MaterialProject,
  MaterialIntake,
  type MaterialArtifact,
  type MaterialMeasurement,
  type MaterialStage,
} from "@synsci/util/materials"
import { buildPrompt } from "../../src/materials/domain"
import { computeStatistics } from "../../src/materials/statistics"
import { validateOutput } from "../../src/materials/validation"

const firstQuote = "BZO nanorods improved the in-field critical current density."
const secondQuote = "Excessive addition degraded the epitaxial texture of the film."
const thirdQuote = "Multilayer interfaces introduced additional angular pinning."

function project() {
  return MaterialProject.parse({
    id: "mat_test",
    workspaceID: "default",
    title: "REBCO 薄膜",
    goal: "研究 REBCO 薄膜钉扎与织构之间的权衡",
    domain: "rebco",
    target: "protocol",
    status: "draft",
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    answers: "",
    questions: [],
    stages: [],
    sources: [
      {
        id: "p1",
        title: "Nanorod paper",
        doi: "10.1000/p1",
        kind: "fulltext",
        text: `${firstQuote}\n${secondQuote}`,
        origin: "upload",
        createdAt: 1,
      },
      {
        id: "p2",
        title: "Multilayer paper",
        doi: "10.1000/p2",
        kind: "fulltext",
        text: `${thirdQuote}\n${secondQuote}`,
        origin: "upload",
        createdAt: 1,
      },
    ],
    artifacts: [],
    batches: [],
    events: [],
    selectedIdeaIDs: [],
  })
}

function tree() {
  return {
    nodes: [
      {
        id: "n1",
        sourceID: "p1",
        title: "纳米棒钉扎",
        records: [
          {
            id: "r1",
            dimension: "Composition tuning",
            strategy: "引入 BZO",
            effect: "提升场下 Jc",
            evidence: { sourceID: "p1", quote: firstQuote },
          },
        ],
        limitations: [
          {
            id: "l1",
            limitation: "过量添加损伤织构",
            expectation: "保持织构同时扩展钉扎",
            evidence: { sourceID: "p1", quote: secondQuote },
          },
        ],
      },
      {
        id: "n2",
        sourceID: "p2",
        title: "界面钉扎",
        records: [
          {
            id: "r2",
            dimension: "Interface tuning",
            strategy: "多层界面",
            effect: "角向钉扎",
            evidence: { sourceID: "p2", quote: thirdQuote },
          },
        ],
        limitations: [
          {
            id: "l2",
            limitation: "织构限制",
            expectation: "验证窗口",
            evidence: { sourceID: "p2", quote: secondQuote },
          },
        ],
      },
    ],
    edges: [
      { parentID: "n1", limitationID: "l1", childID: "n2", type: "transferable", rationale: "界面缺陷作为可迁移方向" },
    ],
    coverageGaps: [],
    reviewNotes: ["效果需按测试条件审查"],
  }
}

function ideas() {
  return {
    ideas: [
      {
        id: "idea1",
        title: "界面与 APC 协同",
        hypothesis: "两类缺陷或可互补",
        design: "验证组合而非假定成功",
        mechanism: "不同取向钉扎",
        strategyIDs: ["r1", "r2"],
        evidence: [
          { sourceID: "p1", quote: firstQuote },
          { sourceID: "p2", quote: thirdQuote },
        ],
        novelty: "组合假设",
        feasibility: "待验证",
        risks: ["织构退化"],
        validation: "同路线对照",
        status: "inferred_design",
        review: { decision: "accept", rationale: "可以作为待验证概念", issues: [] },
        rank: 1,
      },
    ],
    comparison: "仅一个可检验候选，没有比较出最优材料",
  }
}

function protocol() {
  return {
    title: "协同钉扎验证草案",
    ideaIDs: ["idea1"],
    objective: "检验组合假设",
    groups: [{ id: "control", name: "对照", purpose: "基线", variables: "同路线无新增界面", replicates: 3 }],
    steps: [{ order: 1, instruction: "研究人员确认工艺窗口", rationale: "避免超出设备范围" }],
    parameters: [
      {
        name: "路线",
        value: "multilayer",
        unit: "无",
        basis: "literature",
        evidence: [{ sourceID: "p2", quote: thirdQuote }],
      },
    ],
    measurements: ["Jc 温度/磁场/角度"],
    successCriteria: ["相同条件下与对照比较"],
    risks: ["织构退化"],
    confirmations: ["研究人员人工确认设备、工艺窗口与风险"],
  }
}

function artifact(stage: MaterialStage, data: Record<string, unknown>, version = 1): MaterialArtifact {
  return {
    id: `${stage}_${version}`,
    stage,
    version,
    title: stage,
    createdAt: version,
    markdown: "",
    data,
    inputArtifactIDs: [],
  }
}

function prepared() {
  const value = project()
  value.artifacts.push(artifact("strategies", tree()), artifact("ideas", ideas()))
  value.selectedIdeaIDs = ["idea1"]
  return value
}

test("new intake results ask at most two questions while historical intake artifacts remain readable", () => {
  const intake = {
    title: "超导材料方向探索",
    materialSystem: "待确认",
    objective: "提高超导性能",
    constraints: [],
    searchQueries: ["superconducting materials performance"],
    questions: ["你想研究哪类超导材料？", "更希望改善哪方面的表现？"],
    target: "ideas",
  }
  expect(validateOutput("intake", intake, project()).questions).toEqual(intake.questions)
  const legacy = { ...intake, questions: [...intake.questions, "使用什么设备？"] }
  expect(() => validateOutput("intake", legacy, project())).toThrow("questions")
  expect(MaterialIntake.parse(legacy).questions).toHaveLength(3)
  expect(validateOutput("intake", { ...intake, questions: [] }, project()).questions).toEqual([])
})

describe("material evidence and graph validation", () => {
  test("accepts grounded paper nodes and Unicode/whitespace-normalized exact quotes", () => {
    const value = project()
    value.sources[0].text = value.sources[0].text.replace("BZO nanorods", "ＢＺＯ\n  nanorods")
    expect(validateOutput("strategies", tree(), value).nodes).toHaveLength(2)
  })

  test("rejects a nonexistent source, paraphrase or stitched quote", () => {
    const missing = tree()
    missing.nodes[0].sourceID = "invented-paper"
    expect(() => validateOutput("strategies", missing, project())).toThrow("不存在")
    const paraphrase = tree()
    paraphrase.nodes[0].records[0].evidence.quote = "BZO nanorods doubled the current density."
    expect(() => validateOutput("strategies", paraphrase, project())).toThrow("逐字引用")
    paraphrase.nodes[0].records[0].evidence.quote = "BZO nanorods improved the film."
    expect(() => validateOutput("strategies", paraphrase, project())).toThrow("逐字引用")
  })

  test("rejects cross-paper evidence and personal notes as literature", () => {
    const data = tree()
    data.nodes[0].records[0].evidence = { sourceID: "p2", quote: thirdQuote }
    expect(() => validateOutput("strategies", data, project())).toThrow("所在节点")
    const value = project()
    value.sources[0].kind = "note"
    expect(() => validateOutput("strategies", tree(), value)).toThrow("笔记")
  })

  test("requires a source-specific abstract limitation", () => {
    const value = project()
    value.sources[0].kind = "abstract"
    expect(() => validateOutput("strategies", tree(), value)).toThrow("只有摘要")
    const data = { ...tree(), coverageGaps: ["来源 p1 仅有摘要，不能判断全文实验参数。"] }
    expect(validateOutput("strategies", data, value).nodes).toHaveLength(2)
  })

  test("requires a partial-document caveat in both strategy nodes and literature summaries", () => {
    const value = project()
    value.sources[0].kind = "partial"
    value.sources[0].retrieval = { status: "partial", attemptedAt: 1, reason: "一页未提取到正文" }
    expect(() => validateOutput("strategies", tree(), value)).toThrow("仅有部分正文")
    const data = { ...tree(), coverageGaps: ["来源 p1 仅有部分正文，不能推断缺失页面中的工艺。"] }
    expect(validateOutput("strategies", data, value).nodes).toHaveLength(2)
    expect(() => validateOutput("literature", { summary: "文献", sourceIDs: ["p1"], gaps: [] }, value)).toThrow(
      "仅有部分正文",
    )
    expect(
      validateOutput("literature", { summary: "文献", sourceIDs: ["p1"], gaps: data.coverageGaps }, value).sourceIDs,
    ).toEqual(["p1"])
  })

  test("binds fulltext quotes to saved chunks and their actual page numbers", () => {
    const value = project()
    value.sources[0].chunks = [
      { id: "p1_c1", page: 2, text: firstQuote },
      { id: "p1_c2", page: 5, text: secondQuote },
    ]
    const data = tree()
    expect(() => validateOutput("strategies", data, value)).toThrow("chunkID")
    Object.assign(data.nodes[0].records[0].evidence, { chunkID: "p1_c1", page: 2 })
    Object.assign(data.nodes[0].limitations[0].evidence, { chunkID: "p1_c2", page: 5 })
    expect(validateOutput("strategies", data, value).nodes).toHaveLength(2)
    Object.assign(data.nodes[0].records[0].evidence, { chunkID: "p1_c2", page: 5 })
    expect(() => validateOutput("strategies", data, value)).toThrow("不在证据片段")
    Object.assign(data.nodes[0].records[0].evidence, { chunkID: "p1_c1", page: 5 })
    expect(() => validateOutput("strategies", data, value)).toThrow("实际页码不符")
    Object.assign(data.nodes[0].records[0].evidence, { chunkID: "p2_c1", page: 2 })
    expect(() => validateOutput("strategies", data, value)).toThrow("chunkID")
  })

  test("never accepts invented pages for abstracts or unpaged text and preserves legacy PDF page markers", () => {
    const value = project()
    const data = tree()
    Object.assign(data.nodes[0].records[0].evidence, { page: 2 })
    expect(() => validateOutput("strategies", data, value)).toThrow("分页证据")
    value.sources[0].text = `[Page 2]\n${firstQuote}\n[Page 5]\n${secondQuote}`
    expect(validateOutput("strategies", data, value).nodes).toHaveLength(2)
    Object.assign(data.nodes[0].records[0].evidence, { page: 5 })
    expect(() => validateOutput("strategies", data, value)).toThrow("分页证据")
    value.sources[0].chunks = [
      { id: "p1_c1", text: firstQuote },
      { id: "p1_c2", text: secondQuote },
    ]
    Object.assign(data.nodes[0].records[0].evidence, { chunkID: "p1_c1", page: 2 })
    expect(() => validateOutput("strategies", data, value)).toThrow("未记录页码")
    value.sources[0].chunks = undefined
    value.sources[0].kind = "abstract"
    value.sources[0].text = firstQuote
    Object.assign(data.nodes[0].records[0].evidence, { chunkID: undefined, page: 2 })
    expect(() => validateOutput("strategies", { ...data, coverageGaps: ["来源 p1 只有摘要。"] }, value)).toThrow(
      "分页证据",
    )
  })

  test("enforces one paper per node, including duplicate DOI aliases", () => {
    const value = project()
    value.sources[1].doi = "https://doi.org/10.1000/P1"
    expect(() => validateOutput("strategies", tree(), value)).toThrow("同一 DOI")
    const data = tree()
    data.nodes[1].sourceID = "p1"
    expect(() => validateOutput("strategies", data, project())).toThrow("一文一节点")
  })

  test("requires globally unique node, record and limitation IDs", () => {
    const data = tree()
    data.nodes[1].records[0].id = "r1"
    expect(() => validateOutput("strategies", data, project())).toThrow("重复")
    data.nodes[1].records[0].id = "n1"
    expect(() => validateOutput("strategies", data, project())).toThrow("重复")
    data.nodes[1].records[0].id = "r2"
    data.nodes[1].limitations[0].id = "l1"
    expect(() => validateOutput("strategies", data, project())).toThrow("重复")
  })

  test("rejects mixed limitation fields and noncanonical dimensions", () => {
    const data = tree()
    Object.assign(data.nodes[0].records[0], { limitation: "cannot mix" })
    expect(() => validateOutput("strategies", data, project())).toThrow("格式不正确")
    const dimension = tree()
    dimension.nodes[0].records[0].dimension = "performance tuning"
    expect(() => validateOutput("strategies", dimension, project())).toThrow("格式不正确")
  })

  test("rejects dangling nodes, wrong parent limitations and self loops", () => {
    const data = tree()
    data.edges[0].childID = "n-missing"
    expect(() => validateOutput("strategies", data, project())).toThrow("不存在的论文节点")
    data.edges[0].childID = "n2"
    data.edges[0].limitationID = "l2"
    expect(() => validateOutput("strategies", data, project())).toThrow("不属于父节点")
    data.edges[0].limitationID = "l1"
    data.edges[0].childID = "n1"
    expect(() => validateOutput("strategies", data, project())).toThrow("不能连接自己")
  })

  test("rejects cyclic and duplicate expansion edges", () => {
    const cycle = tree()
    cycle.edges.push({
      parentID: "n2",
      limitationID: "l2",
      childID: "n1",
      type: "exploratory",
      rationale: "would close a cycle",
    })
    expect(() => validateOutput("strategies", cycle, project())).toThrow("存在循环")
    const duplicate = tree()
    duplicate.edges.push({ ...duplicate.edges[0] })
    expect(() => validateOutput("strategies", duplicate, project())).toThrow("重复")
  })
})

describe("material idea and protocol gates", () => {
  test("accepts host execution metadata on stored prerequisites while keeping model output strict", () => {
    const value = prepared()
    for (const item of value.artifacts) {
      item.data.execution = [{ role: "reviewer", model: "fixture", inputTokens: 100, outputTokens: 20 }]
    }
    expect(validateOutput("protocol", protocol(), value).ideaIDs).toEqual(["idea1"])
    expect(() => validateOutput("ideas", { ...ideas(), execution: [{ role: "fabricated-reviewer" }] }, value)).toThrow(
      "格式不正确",
    )
  })

  test("accepts traced hypotheses, not claims of validated new designs", () => {
    expect(validateOutput("ideas", ideas(), prepared()).ideas).toHaveLength(1)
    const data = ideas()
    data.ideas[0].status = "evidence_supported"
    expect(() => validateOutput("ideas", data, prepared())).toThrow("格式不正确")
  })

  test("rejects node IDs in place of strategy IDs and incomplete evidence coverage", () => {
    const data = ideas()
    data.ideas[0].strategyIDs = ["n1"]
    expect(() => validateOutput("ideas", data, prepared())).toThrow("不存在的策略记录")
    data.ideas[0].strategyIDs = ["r1", "r2"]
    data.ideas[0].evidence.pop()
    expect(() => validateOutput("ideas", data, prepared())).toThrow("缺少引用策略来源 p2")
  })

  test("prevents rejected candidates from outranking accepted candidates", () => {
    const data = ideas()
    data.ideas.push({ ...structuredClone(data.ideas[0]), id: "idea2", rank: 2 })
    data.ideas[0].review.decision = "reject"
    expect(() => validateOutput("ideas", data, prepared())).toThrow("不能排在")
  })

  test("requires explicit user selection and review acceptance for a protocol", () => {
    expect(validateOutput("protocol", protocol(), prepared()).ideaIDs).toEqual(["idea1"])
    const value = prepared()
    value.selectedIdeaIDs = []
    expect(() => validateOutput("protocol", protocol(), value)).toThrow("先由用户选择")
    value.selectedIdeaIDs = ["other"]
    expect(() => validateOutput("protocol", protocol(), value)).toThrow("未被用户选择")
    value.selectedIdeaIDs = ["idea1"]
    const revised = ideas()
    revised.ideas[0].review.decision = "revise"
    value.artifacts.push(artifact("ideas", revised, 2))
    expect(() => validateOutput("protocol", protocol(), value)).toThrow("尚未通过审查")
  })

  test("requires real evidence for literature parameters and manual confirmation", () => {
    const data = protocol()
    data.parameters[0].evidence = []
    expect(() => validateOutput("protocol", data, prepared())).toThrow("没有原文证据")
    data.parameters[0].evidence = [{ sourceID: "fabricated", quote: thirdQuote }]
    expect(() => validateOutput("protocol", data, prepared())).toThrow("不存在")
    const confirmation = protocol()
    confirmation.confirmations = ["自动开始"]
    expect(() => validateOutput("protocol", confirmation, prepared())).toThrow("人工确认")
  })

  test("rejects analysis without real measurements and invented bibliography IDs", () => {
    expect(() =>
      validateOutput(
        "analysis",
        { summary: "成功", findings: [], limitations: [], nextSteps: [], hypothesisAssessment: "成功" },
        project(),
      ),
    ).toThrow("尚未回填")
    expect(() =>
      validateOutput("literature", { summary: "文献", sourceIDs: ["invented"], gaps: [] }, project()),
    ).toThrow("不存在")
  })
})

function measurement(overrides: Partial<MaterialMeasurement> = {}): MaterialMeasurement {
  return {
    sampleID: "s1",
    groupID: "control",
    property: "Jc",
    value: 1,
    unit: "MA/cm2",
    temperatureK: 77,
    fieldT: 1,
    angleDeg: 0,
    process: "PLD",
    notes: "原始记录",
    ...overrides,
  }
}

function batch(measurements: MaterialMeasurement[], overrides: Partial<MaterialProject["batches"][number]> = {}) {
  return { id: "b1", protocolID: "protocol1", name: "实验一", createdAt: 1, measurements, ...overrides }
}

describe("condition-aware descriptive statistics", () => {
  test("counts records and independent samples separately and preserves all raw fields", () => {
    const input = [batch([measurement(), measurement({ value: 3 }), measurement({ sampleID: "s2", value: 5 })])]
    const original = structuredClone(input)
    const result = computeStatistics(input)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({
      recordCount: 3,
      sampleCount: 2,
      mean: 3,
      sampleStandardDeviation: 2,
      min: 1,
      max: 5,
      conditionStatus: "complete",
    })
    expect(result.records[0]).toMatchObject({ ...input[0].measurements[0], batchID: "b1", protocolID: "protocol1" })
    expect(input).toEqual(original)
  })

  test("never pools different properties, units, temperature, field, angle, groups or protocols", () => {
    const result = computeStatistics([
      batch([
        measurement(),
        measurement({ property: "Ic" }),
        measurement({ unit: "A/cm2" }),
        measurement({ temperatureK: 65 }),
        measurement({ fieldT: 0 }),
        measurement({ angleDeg: 90 }),
        measurement({ groupID: "treated" }),
      ]),
      batch([measurement()], { id: "b2", protocolID: "protocol2" }),
    ])
    expect(result.groups).toHaveLength(8)
    expect(result.groups.every((group) => group.recordCount === 1 && group.sampleStandardDeviation === null)).toBe(true)
    expect(result.warnings.some((warning) => warning.includes("不可直接合并的单位"))).toBe(true)
  })

  test("keeps missing conditions separate from zero and identifies the missing fields", () => {
    const result = computeStatistics([
      batch([
        measurement({ fieldT: undefined }),
        measurement({ fieldT: 0 }),
        measurement({ temperatureK: undefined, angleDeg: undefined }),
      ]),
    ])
    expect(result.groups).toHaveLength(3)
    expect(result.groups[0]).toMatchObject({
      conditionStatus: "incomplete",
      fieldT: null,
      missingConditions: ["fieldT"],
    })
    expect(result.groups[1]).toMatchObject({ conditionStatus: "complete", fieldT: 0 })
    expect(result.groups[2].missingConditions).toEqual(["temperatureK", "angleDeg"])
  })

  test("rejects non-finite input and does not modify unit spelling or raw measurements", () => {
    expect(() => computeStatistics([batch([measurement({ value: NaN })])])).toThrow()
    const result = computeStatistics([batch([measurement({ unit: "MA/cm²" }), measurement({ unit: "MA/cm2" })])])
    expect(result.groups).toHaveLength(2)
    expect(result.records.map((entry) => entry.unit)).toEqual(["MA/cm²", "MA/cm2"])
  })
})

test("bounded prompt context retains latest artifacts without exposing old events or changing sources", () => {
  const value = project()
  for (let index = 0; index < 20; index++)
    value.sources.push({ ...value.sources[0], id: `large${index}`, text: "a".repeat(20_000) })
  value.artifacts.push(artifact("strategies", { old: true }), artifact("strategies", { latest: true }, 2))
  value.events.push({ id: "event", createdAt: 1, message: "event history is irrelevant", kind: "info" })
  const original = structuredClone(value.sources)
  const prompt = buildPrompt("strategies", value)
  const context = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))
  expect(JSON.stringify(context.sources.items).length).toBeLessThanOrEqual(100_000)
  expect(context.sources.items.every((item: { text: string }) => item.text.length <= 12_000)).toBe(true)
  expect(context.sources.items.some((item: { textTruncated: boolean }) => item.textTruncated)).toBe(true)
  expect(context.sources.omittedCount).toBeGreaterThan(0)
  expect(context.artifacts).toHaveLength(1)
  expect(context.artifacts[0].data).toEqual({ latest: true })
  expect(context.events).toBeUndefined()
  expect(value.sources).toEqual(original)
})

test("fulltext context selects relevant body evidence beyond the first 12000 characters with page diversity", () => {
  const value = project()
  const chunks = Array.from({ length: 18 }, (_, index) => ({
    id: `p1_c${index}`,
    page: index + 1,
    text: `Background ${index}: ${"Superconductivity has a long history. ".repeat(45)}`,
  }))
  chunks[10].text = `Experimental methods: REBCO films were deposited using pulsed laser deposition. ${"Detailed fabrication observations. ".repeat(40)}`
  chunks[13].text = `Results: ${firstQuote} ${"The in-field transport measurements show angular dependence. ".repeat(24)}`
  chunks[17].text = `Limitations and conclusions: ${secondQuote} ${"The optimum depends on the measurement conditions. ".repeat(24)}`
  value.sources[0].chunks = chunks
  value.sources[0].text = chunks.map((chunk) => `[p.${chunk.page}]\n${chunk.text}`).join("\n")
  value.sources[0].retrieval = { status: "fulltext", attemptedAt: 1, pageCount: 18, extractor: "pdftotext" }
  value.artifacts.push(
    artifact("intake", { searchQueries: ["REBCO pinning pulsed laser deposition critical current"] }),
  )
  const original = structuredClone(value)
  const prompt = buildPrompt("strategies", value)
  const context = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))
  const paper = context.sources.items.find((item: { id: string }) => item.id === "p1")
  expect(paper.chunks.some((chunk: { id: string }) => chunk.id === "p1_c10")).toBe(true)
  expect(paper.chunks.some((chunk: { id: string }) => chunk.id === "p1_c13")).toBe(true)
  expect(paper.chunks.some((chunk: { id: string }) => chunk.id === "p1_c17")).toBe(true)
  expect(
    paper.chunks.reduce((total: number, chunk: { text: string }) => total + chunk.text.length, 0),
  ).toBeLessThanOrEqual(12_000)
  expect(new Set(paper.chunks.map((chunk: { page: number }) => chunk.page)).size).toBeGreaterThan(3)
  expect(paper.textTruncated).toBe(true)
  expect(paper.omittedChunkCount).toBe(chunks.length - paper.chunks.length)
  expect(paper.retrieval.pageCount).toBe(18)
  expect(buildPrompt("strategies", value)).toBe(prompt)
  expect(value).toEqual(original)
})

test("source budgets count serialized escaping, prefer fulltexts and report omitted papers and chunks", () => {
  const value = project()
  const abstract = { ...value.sources[0], kind: "abstract" as const, text: "a".repeat(20_000) }
  value.sources = Array.from({ length: 20 }, (_, index) => ({ ...abstract, id: `abstract${index}` }))
  const chunks = Array.from({ length: 15 }, (_, index) => ({
    id: `body${index}`,
    page: index + 1,
    text: `Results REBCO ${'"quoted\\\ntext" '.repeat(130)}`,
  }))
  value.sources.push({
    ...abstract,
    id: "body",
    kind: "fulltext",
    chunks,
    text: chunks.map((chunk) => chunk.text).join("\n"),
  })
  const prompt = buildPrompt("strategies", value)
  const context = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))
  expect(context.sources.items[0].id).toBe("body")
  expect(JSON.stringify(context.sources.items).length).toBeLessThanOrEqual(100_000)
  expect(context.sources.omittedCount).toBe(value.sources.length - context.sources.items.length)
  expect(context.sources.omittedCount).toBeGreaterThan(0)
  expect(context.sources.items[0].omittedChunkCount).toBeGreaterThan(0)
  expect(context.sources.items[0].textTruncated).toBe(true)
})
