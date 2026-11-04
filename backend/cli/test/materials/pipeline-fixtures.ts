import {
  MaterialIdeas,
  MaterialIntake,
  MaterialProtocol,
  MaterialStrategies,
  MaterialProject,
} from "@synsci/util/materials"
import type { MaterialGenerate } from "../../src/materials/pipeline"
import type { Provider } from "../../src/provider/provider"

export const modelFixture: Provider.Model = {
  id: "gpt-6-astra",
  providerID: "openai",
  api: { id: "gpt-6-astra", npm: "@ai-sdk/openai" },
  name: "Configured reasoning fixture",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 16_000 },
  status: "active",
  options: { reasoningEffort: "max", reasoningSummary: "auto" },
  headers: {},
  release_date: "",
}

// Synthetic excerpts used only to exercise evidence contracts, not published research.
export const excerpts = {
  strategy: "BZO nanorods improved the in-field critical current density in the test films.",
  limitation: "Excessive addition degraded the epitaxial texture of the test films.",
  interface: "Multilayer interfaces introduced additional angular pinning in the test films.",
}

export const paperInputs = [
  {
    title: "Test fixture: nanorod pinning",
    authors: "Synthetic test fixture",
    kind: "fulltext" as const,
    text: `${excerpts.strategy}\n${excerpts.limitation}`,
  },
  {
    title: "Test fixture: multilayer interface pinning",
    authors: "Synthetic test fixture",
    kind: "fulltext" as const,
    text: `${excerpts.interface}\n${excerpts.limitation}`,
  },
]

export function ideaProjectFixture() {
  const project = MaterialProject.parse({
    id: "mat_pipeline_fixture",
    workspaceID: "default",
    title: "测试材料课题",
    goal: "研究 REBCO 薄膜的 APC 与界面钉扎",
    domain: "rebco",
    target: "ideas",
    status: "running",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    answers: "77 K、1 T，PLD。",
    questions: [],
    stages: [],
    events: [],
    batches: [],
    selectedIdeaIDs: [],
    artifacts: [],
    sources: paperInputs.map((source, index) => ({
      ...source,
      id: `fixture_source_${index}`,
      origin: "upload",
      createdAt: 1,
    })),
  })
  project.artifacts.push({
    id: "artifact-strategies",
    stage: "strategies",
    version: 1,
    title: "策略树",
    createdAt: 1,
    markdown: "",
    inputArtifactIDs: [],
    data: { ...strategyFixture(project), execution: [{ role: "strategies:reviewer", model: "fixture/model" }] },
  })
  return project
}

export function intakeFixture(project: MaterialProject) {
  return MaterialIntake.parse({
    title: "REBCO 薄膜钉扎研究",
    materialSystem: "REBCO 超导薄膜",
    objective: "研究 APC 与多层界面对钉扎的影响",
    constraints: ["PLD", "仅制定待验证方案"],
    searchQueries: ["REBCO PLD films flux pinning"],
    questions: project.answers ? [] : ["实验验证的温度、磁场和设备条件是什么？"],
    target: "protocol",
  })
}

export function strategyFixture(project: MaterialProject) {
  const first = project.sources.find((source) => source.title === paperInputs[0].title)
  const second = project.sources.find((source) => source.title === paperInputs[1].title)
  if (!first || !second) throw new Error("The test generator needs persisted source text")
  return MaterialStrategies.parse({
    nodes: [
      {
        id: "node1",
        sourceID: first.id,
        title: "纳米棒 APC",
        records: [
          {
            id: "record1",
            dimension: "Composition tuning",
            strategy: "引入 BZO 纳米棒",
            effect: "测试薄膜场下 Jc 提升",
            evidence: { sourceID: first.id, quote: excerpts.strategy },
          },
        ],
        limitations: [
          {
            id: "limitation1",
            limitation: "过量添加损伤织构",
            expectation: "保持织构的替代缺陷结构",
            evidence: { sourceID: first.id, quote: excerpts.limitation },
          },
        ],
      },
      {
        id: "node2",
        sourceID: second.id,
        title: "多层界面",
        records: [
          {
            id: "record2",
            dimension: "Interface tuning",
            strategy: "引入多层界面",
            effect: "额外角向钉扎",
            evidence: { sourceID: second.id, quote: excerpts.interface },
          },
        ],
        limitations: [],
      },
    ],
    edges: [
      {
        parentID: "node1",
        limitationID: "limitation1",
        childID: "node2",
        type: "transferable",
        rationale: "通过界面方向探索不同缺陷来源，尚未证实相同工艺兼容性",
      },
    ],
    coverageGaps: ["测试来源没有最佳掺杂量或生长窗口，不能据此给出确定配方"],
    reviewNotes: ["文字引用已核对；机制可迁移性仍是推断"],
  })
}

export function ideaFixture(project: MaterialProject, role = "idea-expert") {
  const tree = strategyFixture(project)
  const first = {
    id: "idea1",
    title: "APC 与界面联合钉扎假设",
    hypothesis: "两类缺陷有可能改善不同取向钉扎",
    design: "以 PLD 薄膜比较 APC 与多层界面，含量和工艺窗口待人工确定",
    mechanism: "不同缺陷取向可能互补，尚待实验验证",
    strategyIDs: ["record1", "record2"],
    evidence: tree.nodes.flatMap((node) => node.records.map((record) => record.evidence)),
    novelty: "来自两条文献策略的组合推断",
    feasibility: "需要实验人员确认设备及工艺兼容性",
    risks: ["织构退化", "缺陷来源归因不明确"],
    validation: "同路线单因素与联合组对照测量 Jc",
    status: "inferred_design",
    review: { decision: "accept", rationale: "可作为有证据依据的待验证候选", issues: [] },
    rank: 1,
  }
  const evolved = {
    ...structuredClone(first),
    id: "idea2",
    title: "分段界面与 APC 的对照设计",
    hypothesis: "分段界面或可减少连续界面的织构扰动",
    design: "提出分段界面作为新结构假设，并加入相同 APC 条件的对照；分段尺寸待确认",
    review: {
      decision: role === "idea-final-review" ? "accept" : "revise",
      rationale: "新结构假设需要独立复核",
      issues: role === "idea-final-review" ? [] : ["等待最终独立审查"],
    },
    rank: role === "idea-final-review" ? 1 : 2,
  }
  const entries = role === "idea-evolution" || role === "idea-final-review" ? [first, evolved] : [first]
  if (role === "idea-final-review") first.rank = 2
  return MaterialIdeas.parse({
    ideas: entries,
    comparison:
      entries.length > 1
        ? "idea2 由 idea1 经 risk_reduce 演化，结构假设有变化；文献并未证明新的组合成功。"
        : "目前只有一个组合候选；已比较与原始文献的差别，不能据此宣称最优。",
  })
}

export function protocolFixture(project: MaterialProject) {
  return MaterialProtocol.parse({
    title: "REBCO 钉扎实验草案",
    ideaIDs: project.selectedIdeaIDs,
    objective: "检验所选结构假设",
    groups: [
      { id: "control", name: "同路线对照", purpose: "建立基线", variables: "不增加新界面结构", replicates: 3 },
      { id: "treated", name: "设计组", purpose: "检验界面假设", variables: "待确认界面结构", replicates: 3 },
    ],
    steps: [
      { order: 1, instruction: "研究人员审核材料、设备与工艺窗口", rationale: "现有证据不支持直接指定全部参数" },
      { order: 2, instruction: "按已确认的工艺制备独立样品并记录偏差", rationale: "保留可追溯实验条件" },
    ],
    parameters: [{ name: "界面结构尺寸", value: "待确认", unit: "nm", basis: "to_confirm", evidence: [] }],
    measurements: ["77 K、1 T 下 Jc，记录磁场角度"],
    successCriteria: ["相同条件下比较独立样品"],
    risks: ["织构退化与归因混淆"],
    confirmations: ["研究人员人工确认设备、配方、操作风险与测试条件后才执行"],
  })
}

export const analysisFixture = {
  summary: "只描述用户回填的实验测量，不代表新材料设计已普遍验证。",
  findings: ["同条件对照组记录均值为 2 MA/cm2，设计组记录均值为 4 MA/cm2。"],
  limitations: ["各组仅两个独立样品，不进行显著性或因果推断。"],
  nextSteps: ["增加独立样品并核查缺陷结构及织构。"],
  hypothesisAssessment: "当前数据仅提示这一测试条件下的差异，需要更多重复与结构证据。",
}

export const flowRoles = [
  "intake",
  "intake",
  "strategy-builder",
  "strategies:reviewer",
  "idea-expert",
  "ideas:reviewer",
  "idea-proximity-ranking",
  "idea-evolution",
  "idea-final-review",
  "protocol",
  "protocol:reviewer",
  "analysis",
]

export function scriptedGenerator(roles = flowRoles) {
  const calls: Parameters<MaterialGenerate>[0][] = []
  const generate: MaterialGenerate = async (input) => {
    const expected = roles[calls.length]
    calls.push(input)
    if (input.role !== expected) throw new Error(`Unexpected fixture call: ${input.role}; expected ${expected}`)
    if (input.signal.aborted) throw input.signal.reason
    const data =
      input.stage === "intake"
        ? intakeFixture(input.project)
        : input.stage === "strategies"
          ? strategyFixture(input.project)
          : input.stage === "ideas"
            ? ideaFixture(input.project, input.role)
            : input.stage === "protocol"
              ? protocolFixture(input.project)
              : input.stage === "analysis"
                ? analysisFixture
                : (() => {
                    throw new Error("Literature must come from saved sources, not generation")
                  })()
    return { text: JSON.stringify(data), model: "fixture/finite-material-model", inputTokens: 101, outputTokens: 202 }
  }
  return { generate, calls }
}
