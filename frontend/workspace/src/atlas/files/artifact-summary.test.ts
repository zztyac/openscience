import { describe, expect, test } from "bun:test"
import { artifactSummary, markdownSummary, structuredSummary } from "./artifact-summary"

describe("result excerpts", () => {
  test("shows actual markdown prose without repeating the document heading or markup", () => {
    const preview = markdownSummary(
      "# 实验方案\n\n以下方案为**待验证假设**，需[实验验证](https://example.org)。\n\n## 分组\n- 保留 J_c 与 BZO 配比。",
    )
    expect(preview.paragraphs).toEqual(["以下方案为待验证假设，需实验验证。", "保留 J_c 与 BZO 配比。"])
  })

  test("extracts hypotheses and exact counts without interpreting review decisions", () => {
    const preview = structuredSummary(
      JSON.stringify({
        ideas: [
          { id: "idea_1", title: "方案一", hypothesis: "有待验证的第一项假设。", review: { decision: "accept" } },
          { id: "idea_2", title: "方案二", hypothesis: "有待验证的第二项假设。", review: { decision: "reject" } },
        ],
      }),
    )
    expect(preview?.paragraphs).toEqual(["有待验证的第一项假设。", "有待验证的第二项假设。"])
    expect(preview?.count).toEqual({ kind: "items", value: 2 })
  })

  test("keeps source summaries ahead of identifiers and titles and bounds long text", () => {
    const preview = structuredSummary(
      JSON.stringify({ id: "src_123", title: "原标题", summary: "仅有摘要，尚未审查全文。".repeat(200), other: 4 }),
    )
    expect(preview?.paragraphs[0]).toStartWith("仅有摘要，尚未审查全文。")
    expect(preview?.paragraphs.join("").length).toBeLessThanOrEqual(600)
    expect(preview?.count).toEqual({ kind: "fields", value: 4 })
    expect(preview?.paragraphs.join("")).not.toContain("src_123")
  })

  test("degrades invalid or excessive JSON to the normal source preview", () => {
    expect(structuredSummary('{"summary":')).toBeUndefined()
    expect(structuredSummary(JSON.stringify({ summary: "a".repeat(70_000) }))).toBeUndefined()
    expect(artifactSummary("print('hello')", "analysis.py", "text/x-python")).toBeUndefined()
    expect(artifactSummary("print('hello')", "analysis.py", "text/plain")).toBeUndefined()
  })

  test("known research stages select source content instead of their execution preambles", () => {
    const ideas =
      "# 创新方案\n\n本对象仅更新 review 与 rank。\n\n## 1. 固定 BZO 总量的厚度分配\n\n分层是否改善 Jc 尚待验证。\n\n### 材料设计\n\n保持共同模板。"
    expect(artifactSummary(ideas, "ideas.md", "text/markdown", "ideas")?.paragraphs).toEqual([
      "固定 BZO 总量的厚度分配",
      "分层是否改善 Jc 尚待验证。",
    ])
    const strategies =
      "# 文献策略树\n\n## 文献标题\n\n来源：src_12345\n\n### Texture tuning\n\n比较 a 轴与 c 轴薄膜。\n\n调控效果：原摘要报告载流差异。"
    expect(artifactSummary(strategies, "strategies.md", "text/markdown", "strategies")?.paragraphs).toEqual([
      "比较 a 轴与 c 轴薄膜。",
      "调控效果：原摘要报告载流差异。",
    ])
    const protocol =
      "# 等 BZO 总量实验草案（待确认）\n\n当前调用针对 idea_123。\n\n## 实验分组\n\n- 均匀组（g_uniform）：名义含量 3 vol.%。\n- 分层组（g_layers）：等厚度比较。\n\n## 实验步骤\n\n先人工确认。"
    expect(artifactSummary(protocol, "protocol.md", "text/markdown", "protocol")?.paragraphs).toEqual([
      "等 BZO 总量实验草案（待确认）",
      "均匀组：名义含量 3 vol.%。",
      "分层组：等厚度比较。",
    ])
  })

  test("unrecognized section formats and ordinary reports retain their usual excerpt", () => {
    const body = "# 创新方案\n\n以下方案有待验证。\n\n## 非编号标题\n\n正文。"
    expect(artifactSummary(body, "ideas.md", "text/markdown", "ideas")).toEqual(markdownSummary(body))
    expect(artifactSummary(body, "ideas.md", "text/markdown")).toEqual(markdownSummary(body))
  })
})
