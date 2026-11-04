import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { MaterialsService, type StageExecutor, type StageResult } from "../../src/materials/workflow"
import { MaterialError } from "../../src/materials/store"
import type { MaterialProject, MaterialStage } from "@synsci/util/materials"

const directories: string[] = []
const services: MaterialsService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function directory() {
  const result = mkdtempSync(path.join(os.tmpdir(), "materials-test-"))
  directories.push(result)
  return result
}
function service(executor: StageExecutor = execute, dir = directory(), concurrency = 2) {
  const result = new MaterialsService({ directory: dir, executor, pollInterval: 10, concurrency })
  services.push(result)
  return result
}
async function until(check: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("Expected workflow state was not reached")
}
function waitAbort(signal: AbortSignal): Promise<StageResult> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}
const evidence = { sourceID: "source-one", quote: "This is a verbatim evidence quotation from the paper." }
const fixtures: Record<MaterialStage, Record<string, unknown>> = {
  intake: {
    title: "REBCO study",
    materialSystem: "REBCO",
    objective: "Improve field Jc",
    constraints: ["PLD"],
    searchQueries: ["REBCO PLD"],
    questions: [],
    target: "protocol",
  },
  literature: { summary: "One paper" },
  strategies: {
    nodes: [
      {
        id: "node-one",
        sourceID: evidence.sourceID,
        title: "Pinning",
        records: [{ id: "strategy-one", dimension: "defect", strategy: "Add pinning", effect: "Higher Jc", evidence }],
        limitations: [],
      },
    ],
    edges: [],
    coverageGaps: [],
    reviewNotes: [],
  },
  ideas: {
    ideas: [
      {
        id: "idea-one",
        title: "Pinning design",
        hypothesis: "Pins improve Jc",
        design: "PLD",
        mechanism: "Pinning",
        strategyIDs: ["strategy-one"],
        evidence: [evidence],
        novelty: "Candidate",
        feasibility: "PLD",
        risks: [],
        validation: "Measure Jc",
        status: "inferred_design",
        review: { decision: "accept", rationale: "Evidence supports test", issues: [] },
        rank: 1,
      },
      {
        id: "idea-rejected",
        title: "Rejected",
        hypothesis: "Unclear",
        design: "None",
        mechanism: "None",
        strategyIDs: ["strategy-one"],
        evidence: [evidence],
        novelty: "No",
        feasibility: "No",
        risks: [],
        validation: "None",
        status: "speculative_extension",
        review: { decision: "reject", rationale: "Unfounded", issues: [] },
        rank: 2,
      },
    ],
    comparison: "Choose accepted",
  },
  protocol: {
    title: "PLD experiment",
    ideaIDs: ["idea-one"],
    objective: "Validate pinning",
    groups: [{ id: "control", name: "Control", purpose: "Baseline", variables: "No added pins", replicates: 3 }],
    steps: [{ order: 1, instruction: "Prepare matched films", rationale: "Control substrate effects" }],
    parameters: [],
    measurements: ["Jc"],
    successCriteria: ["Compare Jc"],
    risks: [],
    confirmations: [],
  },
  analysis: {
    summary: "Measured Jc",
    findings: ["No causal inference from one batch"],
    limitations: ["One batch"],
    nextSteps: ["Repeat"],
    hypothesisAssessment: "Insufficient data",
  },
}
const execute: StageExecutor = async (_project, stage) => ({
  title: stage,
  markdown: `# ${stage}`,
  data: {
    ...structuredClone(fixtures[stage]),
    execution: [{ role: stage, model: "fixture/model", inputTokens: 4, outputTokens: 8 }],
  },
})
const create = {
  goal: "提高 REBCO 薄膜的外场临界电流密度，使用 PLD",
  target: "protocol" as const,
  requestID: "request-one",
}

test("refresh literature upgrades automatic sources before strategies and keeps literature history", async () => {
  let rounds = 0
  const original = {
    id: "auto-paper",
    title: "Exact paper identity",
    authors: "",
    doi: "10.1234/exact",
    origin: "crossref" as const,
    kind: "abstract" as const,
    text: "The original abstract reports enhanced pinning in REBCO films.",
    createdAt: 1,
  }
  const current = service(async (project, stage, signal) => {
    const result = await execute(project, stage, signal)
    if (stage !== "literature") return result
    rounds++
    return {
      ...result,
      sources: [
        rounds === 1
          ? original
          : {
              ...original,
              kind: "fulltext",
              text: "The full paper provides methods and results for enhanced pinning in REBCO films.",
              chunks: [
                {
                  id: "body-chunk",
                  page: 2,
                  text: "The full paper provides methods and results for enhanced pinning in REBCO films.",
                },
              ],
              retrieval: { status: "fulltext", attemptedAt: 2, pageCount: 2 },
            },
      ],
    }
  })
  const project = current.create({ ...create, target: "literature" })
  await until(() => current.get(project.id).status === "completed")
  const before = current.get(project.id)
  current.decide(project.id, { action: "refresh_literature", revision: before.revision })
  await until(() => current.get(project.id).status === "completed")
  const after = current.get(project.id)
  expect(rounds).toBe(2)
  expect(after.sources).toHaveLength(1)
  expect(after.sources[0].id).toBe(original.id)
  expect(after.sources[0].kind).toBe("fulltext")
  expect(after.sources[0].chunks?.[0].page).toBe(2)
  expect(after.artifacts.filter((artifact) => artifact.stage === "literature")).toHaveLength(2)
  expect(after.artifacts.find((artifact) => artifact.id === before.artifacts.at(-1)!.id)).toEqual(
    before.artifacts.at(-1),
  )
})

test("refresh cannot change evidence supporting generated strategies", async () => {
  const current = service()
  const project = current.create({ ...create, target: "strategies" })
  await until(() => current.get(project.id).status === "completed")
  const before = current.get(project.id)
  expect(() => current.decide(project.id, { action: "refresh_literature", revision: before.revision })).toThrow(
    "策略生成之前",
  )
  expect(current.get(project.id)).toEqual(before)
})
function action(
  current: MaterialsService,
  id: string,
  input: {
    action: "select_ideas" | "approve_protocol" | "revise_protocol" | "analyze" | "resume" | "cancel" | "answer"
    ideaIDs?: string[]
    protocolID?: string
    answers?: string
  },
) {
  return current.decide(id, { revision: current.get(id).revision, ...input })
}

describe("materials durable workflow", () => {
  test("runs approval gates and freezes protocol and batch inputs across analysis versions", async () => {
    const snapshots: MaterialProject[] = []
    const current = service(async (project, stage, signal) => {
      if (stage === "analysis") snapshots.push(project)
      return execute(project, stage, signal)
    })
    const project = current.create(create)
    await until(() => current.get(project.id).status === "awaiting_approval")
    expect(current.get(project.id).artifacts.map((item) => item.stage)).toEqual([
      "intake",
      "literature",
      "strategies",
      "ideas",
    ])
    expect(() => action(current, project.id, { action: "select_ideas", ideaIDs: ["idea-rejected"] })).toThrow(
      "只能选择",
    )
    action(current, project.id, { action: "select_ideas", ideaIDs: ["idea-one"] })
    await until(() => current.get(project.id).artifacts.some((item) => item.stage === "protocol"))
    const artifact = current.get(project.id).artifacts.at(-1)!
    expect(() => action(current, project.id, { action: "approve_protocol", protocolID: "wrong" })).toThrow("确切版本")
    action(current, project.id, { action: "approve_protocol", protocolID: artifact.id })
    expect(current.get(project.id).status).toBe("awaiting_data")
    const batch = {
      name: "Batch 1",
      protocolID: artifact.id,
      measurements: [
        {
          sampleID: "sample-1",
          groupID: "control",
          property: "Jc",
          value: 2.3,
          unit: "MA/cm2",
          temperatureK: 77,
          fieldT: 1,
        },
      ],
    }
    expect(() =>
      current.batch(project.id, { ...batch, protocolID: "wrong", revision: current.get(project.id).revision }),
    ).toThrow("方案版本")
    expect(() =>
      current.batch(project.id, {
        ...batch,
        measurements: [{ ...batch.measurements[0], groupID: "unknown" }],
        revision: current.get(project.id).revision,
      }),
    ).toThrow("实验组")
    expect(() =>
      current.batch(project.id, {
        ...batch,
        measurements: [{ ...batch.measurements[0], temperatureK: undefined }],
        revision: current.get(project.id).revision,
      }),
    ).toThrow("温度")
    current.batch(project.id, { ...batch, revision: current.get(project.id).revision })
    action(current, project.id, { action: "analyze" })
    await until(() => current.get(project.id).status === "completed")
    const first = current.get(project.id).artifacts.at(-1)!
    expect(first.inputArtifactIDs).toEqual([artifact.id, current.get(project.id).batches[0].id])
    current.batch(project.id, { ...batch, name: "Batch 2", revision: current.get(project.id).revision })
    action(current, project.id, { action: "analyze" })
    await until(() => current.get(project.id).status === "completed")
    expect(
      current
        .get(project.id)
        .artifacts.filter((item) => item.stage === "analysis")
        .map((item) => item.version),
    ).toEqual([1, 2])
    expect(current.get(project.id).artifacts.find((item) => item.id === first.id)).toEqual(first)
    expect(snapshots.map((item) => item.batches.length)).toEqual([1, 2])
    expect(first.data.execution).toEqual([
      { role: "analysis", model: "fixture/model", inputTokens: 4, outputTokens: 8 },
    ])
    expect(first.data.statistics).toMatchObject({ groups: [{ mean: 2.3, recordCount: 1 }] })
  })
  test("protocol revision retains the old artifact and only the latest unapproved version can be approved", async () => {
    const snapshots: MaterialProject[] = []
    const current = service(async (project, stage, signal) => {
      if (stage === "protocol") snapshots.push(project)
      return execute(project, stage, signal)
    })
    const project = current.create(create)
    await until(() => current.get(project.id).status === "awaiting_approval")
    action(current, project.id, { action: "select_ideas", ideaIDs: ["idea-one"] })
    await until(() => current.get(project.id).artifacts.some((artifact) => artifact.stage === "protocol"))
    const original = current.get(project.id).artifacts.at(-1)!
    expect(() => action(current, project.id, { action: "revise_protocol", answers: " " })).toThrow("修改要求")
    action(current, project.id, { action: "revise_protocol", answers: "增加一组空白对照，将测试温度固定为 77 K" })
    await until(() => current.get(project.id).status === "awaiting_approval")
    const revised = current.get(project.id).artifacts.at(-1)!
    expect(revised.version).toBe(2)
    expect(current.get(project.id).artifacts.find((artifact) => artifact.id === original.id)).toEqual(original)
    expect(snapshots[1].answers).toContain("增加一组空白对照")
    expect(() => action(current, project.id, { action: "approve_protocol", protocolID: original.id })).toThrow(
      "确切版本",
    )
    action(current, project.id, { action: "approve_protocol", protocolID: revised.id })
    expect(current.get(project.id).approvedProtocolID).toBe(revised.id)
    expect(() => action(current, project.id, { action: "revise_protocol", answers: "更改组别" })).toThrow("尚未确认")
  })

  test("answers rerun intake and short targets stop early", async () => {
    const current = service(async (project, stage, signal) => {
      const result = await execute(project, stage, signal)
      if (stage === "intake" && !project.answers) result.data.questions = ["目标温度是多少？"]
      return result
    })
    const project = current.create({ ...create, target: "literature" })
    await until(() => current.get(project.id).status === "needs_input")
    action(current, project.id, { action: "answer", answers: "77 K，1 T" })
    await until(() => current.get(project.id).status === "completed")
    expect(current.get(project.id).artifacts.map((item) => item.stage)).toEqual(["intake", "intake", "literature"])
    expect(current.get(project.id).stages.find((item) => item.key === "strategies")?.status).toBe("skipped")
  })

  test("auto resolves its endpoint after clarification and exploratory work stops at ideas", async () => {
    const goal = "提高超导性能"
    const answers = "REBCO 薄膜，实验条件还没想好，先了解方向"
    const current = service(async (project, stage, signal) => {
      const result = await execute(project, stage, signal)
      if (stage !== "intake") return result
      result.data = {
        ...result.data,
        objective: project.goal,
        constraints: project.answers ? ["实验条件待确认"] : [],
        questions: project.answers ? [] : ["你想研究哪类超导材料？"],
        target: project.answers ? "ideas" : "protocol",
      }
      return result
    })
    const created = current.create({ goal, requestID: "short-auto-goal" })
    await until(() => current.get(created.id).status === "needs_input")
    expect(current.get(created.id).target).toBe("auto")
    action(current, created.id, { action: "answer", answers })
    await until(() => current.get(created.id).status === "completed")
    const completed = current.get(created.id)
    expect(completed.goal).toBe(goal)
    expect(completed.answers).toBe(answers)
    expect(completed.target).toBe("ideas")
    expect(completed.questions).toEqual([])
    expect(completed.artifacts.map((item) => item.stage)).toEqual([
      "intake",
      "intake",
      "literature",
      "strategies",
      "ideas",
    ])
    expect(completed.artifacts[0].data.target).toBe("protocol")
    expect(completed.artifacts[1].data.constraints).toEqual(["实验条件待确认"])
    expect(completed.stages.find((stage) => stage.key === "protocol")?.status).toBe("skipped")
    expect(completed.selectedIdeaIDs).toEqual([])
    expect(completed.approvedProtocolID).toBeUndefined()
  })

  test("all rejected ideas remain auditable and retry only ideas instead of stranding approval", async () => {
    let attempts = 0
    const current = service(async (project, stage, signal) => {
      const result = await execute(project, stage, signal)
      if (stage === "ideas" && attempts++ === 0) {
        result.data = {
          ...result.data,
          ideas: (result.data.ideas as Array<{ review: { decision: string } }>).map((idea) => ({
            ...idea,
            review: { decision: "reject", rationale: "Insufficient support", issues: [] },
          })),
        }
      }
      return result
    })
    const project = current.create(create)
    await until(() => current.get(project.id).status === "failed")
    const rejected = current.get(project.id).artifacts.at(-1)!
    expect(rejected.stage).toBe("ideas")
    expect(current.get(project.id).error).toContain("没有通过评审")
    action(current, project.id, { action: "resume" })
    await until(() => current.get(project.id).status === "awaiting_approval")
    expect(current.get(project.id).artifacts.map((artifact) => artifact.stage)).toEqual([
      "intake",
      "literature",
      "strategies",
      "ideas",
      "ideas",
    ])
    expect(current.get(project.id).artifacts.find((artifact) => artifact.id === rejected.id)).toEqual(rejected)
  })

  test("a completed ideas task continues to an unapproved protocol only after a valid human selection", async () => {
    const stages: MaterialStage[] = []
    const current = service(async (project, stage, signal) => {
      stages.push(stage)
      return execute(project, stage, signal)
    })
    const created = current.create({ ...create, target: "ideas" })
    await until(() => current.get(created.id).status === "completed")
    const explored = current.get(created.id)
    expect(stages).toEqual(["intake", "literature", "strategies", "ideas"])
    expect(explored.selectedIdeaIDs).toEqual([])
    expect(explored.approvedProtocolID).toBeUndefined()
    expect(explored.stages.find((stage) => stage.key === "protocol")?.status).toBe("skipped")
    for (const ideaIDs of [
      [],
      ["idea-rejected"],
      ["missing"],
      ["idea-one", "idea-one"],
      ["idea-one", "idea-rejected"],
    ]) {
      expect(() => action(current, created.id, { action: "select_ideas", ideaIDs })).toThrow("只能选择")
      expect(current.get(created.id)).toEqual(explored)
    }
    const queued = action(current, created.id, { action: "select_ideas", ideaIDs: ["idea-one"] })
    expect(queued.status).toBe("queued")
    expect(queued.target).toBe("protocol")
    expect(queued.stages.find((stage) => stage.key === "protocol")?.status).toBe("pending")
    expect(queued.artifacts).toEqual(explored.artifacts)
    await until(() => current.get(created.id).status === "awaiting_approval")
    const planned = current.get(created.id)
    expect(stages).toEqual(["intake", "literature", "strategies", "ideas", "protocol"])
    expect(planned.artifacts.slice(0, -1)).toEqual(explored.artifacts)
    expect(planned.artifacts.at(-1)?.stage).toBe("protocol")
    expect(planned.selectedIdeaIDs).toEqual(["idea-one"])
    expect(planned.approvedProtocolID).toBeUndefined()
    expect(() => action(current, created.id, { action: "select_ideas", ideaIDs: ["idea-one"] })).toThrow("不接受")
    expect(current.get(created.id)).toEqual(planned)
  })

  test("other completed endpoints and a missing ideas artifact cannot be promoted by selecting candidates", async () => {
    const current = service()
    for (const target of ["literature", "strategies"] as const) {
      const created = current.create({ ...create, target, requestID: `completed-${target}` })
      await until(() => current.get(created.id).status === "completed")
      const completed = current.get(created.id)
      expect(() => action(current, created.id, { action: "select_ideas", ideaIDs: ["idea-one"] })).toThrow("不接受")
      expect(current.get(created.id)).toEqual(completed)
    }
    const created = current.create({ ...create, target: "ideas", requestID: "missing-ideas" })
    const missing = current.store.update(created.id, created.revision, (project) => {
      project.status = "completed"
    })
    expect(() => action(current, created.id, { action: "select_ideas", ideaIDs: ["idea-one"] })).toThrow("尚未生成")
    expect(current.get(created.id)).toEqual(missing)
  })

  test("adding sources to a completed literature task reruns literature and preserves skipped downstream stages", async () => {
    const stages: MaterialStage[] = []
    const current = service(async (project, stage, signal) => {
      stages.push(stage)
      return execute(project, stage, signal)
    })
    const project = current.create({ ...create, target: "literature" })
    await until(() => current.get(project.id).status === "completed")
    current.source(project.id, {
      title: "Extra paper",
      kind: "abstract",
      text: "A new full abstract with sufficiently detailed scientific evidence.",
    })
    expect(current.get(project.id).status).toBe("draft")
    action(current, project.id, { action: "resume" })
    await until(() => current.get(project.id).status === "completed")
    expect(stages).toEqual(["intake", "literature", "literature"])
    expect(current.get(project.id).stages.find((stage) => stage.key === "strategies")?.status).toBe("skipped")
  })

  test("deduplicates create and rejects stale revisions or duplicate execution", async () => {
    const current = service((_project, _stage, signal) => waitAbort(signal))
    const project = current.create(create)
    expect(current.create(create).id).toBe(project.id)
    expect(() => current.create({ ...create, goal: "Another different REBCO research objective" })).toThrow("请求编号")
    await until(() => current.get(project.id).status === "running")
    expect(() => current.decide(project.id, { action: "cancel", revision: project.revision })).toThrow("课题已更新")
    expect(() => action(current, project.id, { action: "resume" })).toThrow("已经在执行")
  })
  test("limits global concurrency to two in FIFO order and cancellation aborts execution", async () => {
    const starts: string[] = [],
      aborted: string[] = []
    const current = service(async (project, _stage, signal) => {
      starts.push(project.id)
      signal.addEventListener("abort", () => aborted.push(project.id), { once: true })
      return waitAbort(signal)
    })
    const first = current.create(create),
      second = current.create({ ...create, requestID: "two" }),
      third = current.create({ ...create, requestID: "three" })
    await until(() => starts.length === 2)
    expect(starts).toEqual([first.id, second.id])
    expect(current.get(third.id).status).toBe("queued")
    action(current, first.id, { action: "cancel" })
    await until(() => starts.length === 3)
    expect(aborted).toContain(first.id)
    expect(current.get(first.id).status).toBe("cancelled")
    expect(starts.at(-1)).toBe(third.id)
  })
  test("a second service does not duplicate jobs and can cancel the owner's task", async () => {
    const dir = directory(),
      starts: string[] = []
    const executor: StageExecutor = (project, _stage, signal) => {
      starts.push(project.id)
      return waitAbort(signal)
    }
    const first = service(executor, dir),
      second = service(executor, dir)
    const project = second.create(create)
    await until(() => starts.length === 1)
    await Bun.sleep(40)
    expect(starts).toEqual([project.id])
    action(second, project.id, { action: "cancel" })
    await until(() => first.get(project.id).status === "cancelled")
    expect(first.get(project.id).status).toBe("cancelled")
  })
  test("dead scheduler recovery interrupts jobs and resumes only unfinished stages", async () => {
    const dir = directory()
    const original = service(
      async (project, stage, signal) => (stage === "literature" ? waitAbort(signal) : execute(project, stage, signal)),
      dir,
    )
    const project = original.create({ ...create, target: "literature" })
    await until(() => original.get(project.id).stages.find((stage) => stage.key === "literature")?.status === "running")
    const intakeID = original.get(project.id).artifacts[0].id
    original.store.db.query("UPDATE scheduler SET pid=?,owner=? WHERE id=1").run(2_147_483_647, "dead-owner")
    const stages: MaterialStage[] = []
    const recovered = service(async (project, stage, signal) => {
      stages.push(stage)
      return execute(project, stage, signal)
    }, dir)
    expect(recovered.get(project.id).status).toBe("interrupted")
    original.close()
    action(recovered, project.id, { action: "resume" })
    await until(() => recovered.get(project.id).status === "completed")
    expect(stages).toEqual(["literature"])
    expect(recovered.get(project.id).artifacts[0].id).toBe(intakeID)
  })
  test("failures accept evidence repair before strategies but immutable artifacts remain protected", async () => {
    const current = service(async (project, stage, signal) => {
      if (stage === "literature" && !project.sources.length) throw new MaterialError(400, "请上传论文摘要或全文")
      return execute(project, stage, signal)
    })
    const project = current.create({ ...create, target: "strategies" })
    await until(() => current.get(project.id).status === "failed")
    expect(current.get(project.id).error).toBe("请上传论文摘要或全文")
    const source = {
      title: "Paper",
      kind: "fulltext" as const,
      text: "A sufficiently long paper passage for source validation.",
    }
    expect(() => current.source(project.id, { ...source, url: "file:///etc/passwd" })).toThrow("HTTP")
    current.source(project.id, source)
    action(current, project.id, { action: "resume" })
    await until(() => current.get(project.id).status === "completed")
    expect(() => current.source(project.id, source)).toThrow("不能修改证据")
    expect(current.get(project.id).sources[0].id).toMatch(/^src_/)
    expect(() =>
      current.store.update(project.id, undefined, (next) => {
        next.artifacts[0].title = "changed"
      }),
    ).toThrow("Immutable")
  })
  test("another operating-system process owns execution until a crash requires explicit recovery", async () => {
    const dir = directory()
    const runner = path.join(dir, "worker.ts")
    const marker = path.join(dir, "ready")
    await Bun.write(
      runner,
      `import { MaterialsService } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/materials/workflow.ts"))};
      const service = new MaterialsService({directory: ${JSON.stringify(dir)}, pollInterval: 10, executor: async () => { await new Promise(() => {}); throw new Error("unreachable"); }});
      await Bun.write(${JSON.stringify(marker)}, "ready");
      setInterval(() => {}, 1000);`,
    )
    const worker = Bun.spawn([process.execPath, runner], { stdout: "ignore", stderr: "pipe" })
    try {
      await until(() => Bun.file(marker).size > 0)
      const stages: MaterialStage[] = []
      const parent = service(async (project, stage, signal) => {
        stages.push(stage)
        return execute(project, stage, signal)
      }, dir)
      const project = parent.create({ ...create, target: "literature" })
      await until(() => parent.get(project.id).status === "running")
      expect(stages).toEqual([])
      worker.kill("SIGKILL")
      await worker.exited
      await until(() => parent.get(project.id).status === "interrupted")
      expect(stages).toEqual([])
      action(parent, project.id, { action: "resume" })
      await until(() => parent.get(project.id).status === "completed")
      expect(stages).toEqual(["intake", "literature"])
    } finally {
      worker.kill()
      await worker.exited
    }
  })

  test("a late executor result cannot overwrite cancellation", async () => {
    const current = service(async () => {
      await Bun.sleep(70)
      return { data: fixtures.intake, markdown: "intake", title: "intake" }
    })
    const project = current.create(create)
    await until(() => current.get(project.id).status === "running")
    action(current, project.id, { action: "cancel" })
    await Bun.sleep(100)
    expect(current.get(project.id).status).toBe("cancelled")
    expect(current.get(project.id).artifacts).toHaveLength(0)
  })
})
