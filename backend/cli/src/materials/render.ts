import {
  MaterialIntake,
  MaterialStrategies,
  MaterialIdeas,
  MaterialProtocol,
  MaterialAnalysis,
  type MaterialStage,
} from "@synsci/util/materials"

const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "暂无。")

export function renderMaterial(stage: MaterialStage, data: Record<string, unknown>): string {
  if (stage === "intake") {
    const item = MaterialIntake.parse(data)
    return `# ${item.title}\n\n${item.objective}\n\n## 材料体系\n\n${item.materialSystem}\n\n## 研究约束\n\n${list(item.constraints)}\n\n## 待补充信息\n\n${list(item.questions)}`
  }
  if (stage === "literature")
    return `# 文献与证据\n\n${String(data.summary ?? "")}\n\n## 证据缺口\n\n${list(Array.isArray(data.gaps) ? data.gaps.map(String) : [])}`
  if (stage === "strategies") {
    const item = MaterialStrategies.parse(data)
    return `# 文献策略树\n\n${item.nodes.map((node) => `## ${node.title}\n\n来源：${node.sourceID}\n\n${node.records.map((record) => `### ${record.dimension}\n\n${record.strategy}\n\n调控效果：${record.effect}\n\n> ${record.evidence.quote}`).join("\n\n")}\n\n${node.limitations.map((entry) => `- 局限：${entry.limitation}\n- 待解决：${entry.expectation}`).join("\n")}`).join("\n\n")}\n\n## 证据缺口\n\n${list(item.coverageGaps)}\n\n## 评审记录\n\n${list(item.reviewNotes)}`
  }
  if (stage === "ideas") {
    const item = MaterialIdeas.parse(data)
    return `# 创新方案\n\n以下方案为待实验验证的研究假设。\n\n${item.comparison}\n\n${item.ideas.map((idea) => `## ${idea.rank}. ${idea.title}\n\n${idea.hypothesis}\n\n### 材料设计\n\n${idea.design}\n\n### 机理推断\n\n${idea.mechanism}\n\n### 创新性与可行性\n\n${idea.novelty}\n\n${idea.feasibility}\n\n### 验证构想\n\n${idea.validation}\n\n### 风险\n\n${list(idea.risks)}\n\n### AI 评审\n\n${idea.review.decision}：${idea.review.rationale}\n\n${list(idea.review.issues)}`).join("\n\n")}`
  }
  if (stage === "protocol") {
    const item = MaterialProtocol.parse(data)
    return `# ${item.title}\n\n实验草案，需研究人员确认后执行。\n\n${item.objective}\n\n## 实验分组\n\n${item.groups.map((group) => `- ${group.name}（${group.id}）：${group.purpose}；${group.variables}；建议重复 ${group.replicates} 次`).join("\n")}\n\n## 实验步骤\n\n${item.steps.map((step) => `${step.order}. ${step.instruction}\n   依据：${step.rationale}`).join("\n\n")}\n\n## 参数及依据\n\n${item.parameters.map((parameter) => `- ${parameter.name}：${parameter.value} ${parameter.unit}（${{ literature: "文献依据", proposed: "待验证建议", to_confirm: "待确认" }[parameter.basis]}）`).join("\n")}\n\n## 测量与评价\n\n${list(item.measurements)}\n\n${list(item.successCriteria)}\n\n## 待确认\n\n${list(item.confirmations)}\n\n## 风险\n\n${list(item.risks)}`
  }
  const item = MaterialAnalysis.parse(data)
  return `# 实验结果分析\n\n${item.summary}\n\n## 观察结果\n\n${list(item.findings)}\n\n## 假设评估\n\n${item.hypothesisAssessment}\n\n## 局限\n\n${list(item.limitations)}\n\n## 下一轮建议\n\n${list(item.nextSteps)}`
}
