import z from "zod"

export const MaterialStage = z.enum(["intake", "literature", "strategies", "ideas", "protocol", "analysis"])
export type MaterialStage = z.infer<typeof MaterialStage>
export const MaterialSkillName = z.enum([
  "arxiv",
  "deepxiv",
  "exa-search",
  "openalex",
  "research-lit",
  "semantic-scholar",
])
export type MaterialSkillName = z.infer<typeof MaterialSkillName>
const stageSkills = z.array(MaterialSkillName).max(6)
export const MaterialSkillBindings = z
  .object({
    intake: stageSkills,
    literature: stageSkills,
    strategies: stageSkills,
    ideas: stageSkills,
    protocol: stageSkills,
    analysis: stageSkills,
  })
  .strict()
export const MaterialSkillConfig = z
  .object({ revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), stages: MaterialSkillBindings })
  .strict()
export type MaterialSkillConfig = z.infer<typeof MaterialSkillConfig>
export const MaterialSkillSnapshot = MaterialSkillConfig.extend({
  catalog: z.array(
    z.object({
      name: MaterialSkillName,
      description: z.string(),
      available: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
})
export type MaterialSkillSnapshot = z.infer<typeof MaterialSkillSnapshot>
export const MaterialSkillExecution = z.object({
  configRevision: z.number().int().nonnegative(),
  skills: z
    .array(
      z.object({
        name: MaterialSkillName,
        hash: z.string().max(128).optional(),
        status: z.enum(["completed", "unavailable", "failed", "unused"]),
        calls: z.number().int().nonnegative(),
        reason: z.string().max(1000).optional(),
      }),
    )
    .max(6),
  calls: z
    .array(
      z.object({
        skill: MaterialSkillName,
        tool: z.string().min(1).max(100),
        status: z.enum(["completed", "failed"]),
        count: z.number().int().nonnegative().optional(),
      }),
    )
    .max(200),
  warnings: z.array(z.string().max(1000)).max(100),
  model: z.string().max(300).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
})
export type MaterialSkillExecution = z.infer<typeof MaterialSkillExecution>
export const MaterialTarget = z.enum(["auto", "literature", "strategies", "ideas", "protocol"])
export const MaterialStatus = z.enum([
  "draft",
  "queued",
  "running",
  "needs_input",
  "awaiting_approval",
  "awaiting_data",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
])
export type MaterialStatus = z.infer<typeof MaterialStatus>
export const MaterialActivityUpdate = z
  .object({
    phase: z.enum([
      "preparing",
      "searching",
      "retrieving",
      "waiting",
      "reasoning",
      "generating",
      "validating",
      "repairing",
      "saving",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    role: z.string().max(100).optional(),
    model: z.string().max(300).optional(),
    step: z.number().int().positive().optional(),
    steps: z.number().int().positive().optional(),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    item: z.string().max(500).optional(),
    outputChars: z.number().int().nonnegative().optional(),
  })
  .strict()
export type MaterialActivityUpdate = z.infer<typeof MaterialActivityUpdate>
export type MaterialReporter = (update: MaterialActivityUpdate) => void
export const MaterialActivity = MaterialActivityUpdate.extend({
  stage: MaterialStage,
  startedAt: z.number(),
  updatedAt: z.number(),
  lastModelActivityAt: z.number().optional(),
})
export type MaterialActivity = z.infer<typeof MaterialActivity>
export const MaterialActivitySnapshot = z.object({
  projectID: z.string(),
  revision: z.number().int(),
  status: MaterialStatus,
  serverTime: z.number(),
  current: MaterialActivity.optional(),
  events: z.array(MaterialActivity.extend({ id: z.string() })).max(200),
})
export type MaterialActivitySnapshot = z.infer<typeof MaterialActivitySnapshot>
export const MaterialSource = z.object({
  id: z.string(),
  title: z.string().min(1).max(500),
  authors: z.string().max(2000).default(""),
  doi: z.string().max(300).optional(),
  url: z.string().url().optional(),
  fulltextURL: z.string().url().optional(),
  year: z.number().int().optional(),
  kind: z.enum(["fulltext", "partial", "abstract", "note"]),
  text: z.string().min(20).max(200_000),
  origin: z.enum([
    "upload",
    "openalex",
    "crossref",
    "supramas",
    "arxiv",
    "deepxiv",
    "exa-search",
    "research-lit",
    "semantic-scholar",
  ]),
  createdAt: z.number(),
  retrieval: z
    .object({
      status: z.enum(["fulltext", "partial", "unavailable"]),
      reason: z.string().max(1000).optional(),
      attemptedAt: z.number(),
      url: z.string().url().optional(),
      pageCount: z.number().int().positive().optional(),
      extractor: z.string().max(100).optional(),
    })
    .optional(),
  chunks: z
    .array(
      z.object({ id: z.string(), page: z.number().int().positive().optional(), text: z.string().min(1).max(2000) }),
    )
    .max(2000)
    .optional(),
})
export type MaterialSource = z.infer<typeof MaterialSource>
export const MaterialEvidence = z.object({
  sourceID: z.string(),
  quote: z.string().min(12),
  page: z.number().int().positive().optional(),
  chunkID: z.string().optional(),
})
export const MaterialIntake = z.object({
  title: z.string(),
  materialSystem: z.string(),
  objective: z.string(),
  constraints: z.array(z.string()),
  searchQueries: z.array(z.string()).min(1).max(4),
  questions: z.array(z.string()).max(5),
  target: z.enum(["literature", "strategies", "ideas", "protocol"]),
})
export const MaterialStrategies = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        sourceID: z.string(),
        title: z.string(),
        records: z
          .array(
            z.object({
              id: z.string(),
              dimension: z.string(),
              strategy: z.string(),
              effect: z.string(),
              evidence: MaterialEvidence,
            }),
          )
          .min(1),
        limitations: z.array(
          z.object({ id: z.string(), limitation: z.string(), expectation: z.string(), evidence: MaterialEvidence }),
        ),
      }),
    )
    .min(1),
  edges: z.array(
    z.object({
      parentID: z.string(),
      limitationID: z.string(),
      childID: z.string(),
      type: z.enum(["direct", "transferable", "exploratory"]),
      rationale: z.string(),
    }),
  ),
  coverageGaps: z.array(z.string()),
  reviewNotes: z.array(z.string()),
})
export const MaterialIdeas = z.object({
  ideas: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        hypothesis: z.string(),
        design: z.string(),
        mechanism: z.string(),
        strategyIDs: z.array(z.string()).min(1),
        evidence: z.array(MaterialEvidence).min(1),
        novelty: z.string(),
        feasibility: z.string(),
        risks: z.array(z.string()),
        validation: z.string(),
        status: z.enum(["inferred_design", "speculative_extension"]),
        review: z.object({
          decision: z.enum(["accept", "revise", "reject"]),
          rationale: z.string(),
          issues: z.array(z.string()),
        }),
        rank: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(12),
  comparison: z.string(),
})
export const MaterialProtocol = z.object({
  title: z.string(),
  ideaIDs: z.array(z.string()).min(1),
  objective: z.string(),
  groups: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        purpose: z.string(),
        variables: z.string(),
        replicates: z.number().int().positive(),
      }),
    )
    .min(1),
  steps: z
    .array(z.object({ order: z.number().int().positive(), instruction: z.string(), rationale: z.string() }))
    .min(1),
  parameters: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      unit: z.string(),
      basis: z.enum(["literature", "proposed", "to_confirm"]),
      evidence: z.array(MaterialEvidence),
    }),
  ),
  measurements: z.array(z.string()).min(1),
  successCriteria: z.array(z.string()),
  risks: z.array(z.string()),
  confirmations: z.array(z.string()),
})
export const MaterialMeasurement = z.object({
  sampleID: z.string().min(1).max(100),
  groupID: z.string().min(1).max(100),
  property: z.string().min(1).max(100),
  value: z.number().finite(),
  unit: z.string().min(1).max(40),
  temperatureK: z.number().nonnegative().optional(),
  fieldT: z.number().nonnegative().optional(),
  angleDeg: z.number().min(-360).max(360).optional(),
  process: z.string().max(4000).default(""),
  notes: z.string().max(4000).default(""),
})
export type MaterialMeasurement = z.infer<typeof MaterialMeasurement>
export const MaterialBatch = z.object({
  id: z.string(),
  protocolID: z.string(),
  name: z.string(),
  createdAt: z.number(),
  measurements: z.array(MaterialMeasurement).min(1).max(5000),
  rawCSV: z.string().max(2_000_000).optional(),
})
export const MaterialAnalysis = z.object({
  summary: z.string(),
  findings: z.array(z.string()),
  limitations: z.array(z.string()),
  nextSteps: z.array(z.string()),
  hypothesisAssessment: z.string(),
})
export const MaterialArtifact = z.object({
  id: z.string(),
  stage: MaterialStage,
  version: z.number().int().positive(),
  title: z.string(),
  createdAt: z.number(),
  markdown: z.string(),
  data: z.record(z.string(), z.unknown()),
  inputArtifactIDs: z.array(z.string()),
})
export type MaterialArtifact = z.infer<typeof MaterialArtifact>
export const MaterialStep = z.object({
  key: MaterialStage,
  status: z.enum(["pending", "running", "completed", "failed", "interrupted", "skipped"]),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
})
export const MaterialEvent = z.object({
  id: z.string(),
  createdAt: z.number(),
  stage: MaterialStage.optional(),
  message: z.string(),
  kind: z.enum(["info", "error", "decision"]),
})
export const MaterialProject = z.object({
  id: z.string(),
  workspaceID: z.literal("default"),
  sessionID: z.string().min(1).max(200).optional(),
  title: z.string(),
  goal: z.string(),
  domain: z.literal("rebco"),
  target: MaterialTarget,
  status: MaterialStatus,
  revision: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  answers: z.string(),
  questions: z.array(z.string()),
  stages: z.array(MaterialStep),
  sources: z.array(MaterialSource),
  artifacts: z.array(MaterialArtifact),
  batches: z.array(MaterialBatch),
  events: z.array(MaterialEvent),
  selectedIdeaIDs: z.array(z.string()),
  approvedProtocolID: z.string().optional(),
  error: z.string().optional(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
})
export type MaterialProject = z.infer<typeof MaterialProject>
export const MaterialLibraryFile = z.object({
  kind: z.enum(["paper", "data", "report", "index"]),
  title: z.string(),
  path: z.string(),
  mimeType: z.string(),
  sourceID: z.string().optional(),
  materialArtifactID: z.string().optional(),
  batchID: z.string().optional(),
  resultID: z.string().optional(),
  resultVersionID: z.string().optional(),
})
export type MaterialLibraryFile = z.infer<typeof MaterialLibraryFile>
export const MaterialLibrarySnapshot = z.object({
  materialsProjectID: z.string(),
  status: z.enum(["unbound", "pending", "syncing", "synced", "partial", "error"]),
  revision: z.number().int().optional(),
  projectID: z.string().optional(),
  sessionID: z.string().optional(),
  directory: z.string().optional(),
  root: z.string().optional(),
  location: z.enum(["working", "scratch"]).optional(),
  updatedAt: z.number().optional(),
  files: z.array(MaterialLibraryFile),
  warnings: z.array(z.string()),
  message: z.string().optional(),
})
export type MaterialLibrarySnapshot = z.infer<typeof MaterialLibrarySnapshot>
export const MaterialCreate = z
  .object({
    goal: z.string().trim().min(1).max(20_000),
    title: z.string().trim().max(150).optional(),
    target: MaterialTarget.default("auto"),
    requestID: z.string().min(1).max(100),
    model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  })
  .strict()
export const MaterialSourceInput = MaterialSource.omit({
  id: true,
  fulltextURL: true,
  createdAt: true,
  origin: true,
  retrieval: true,
  chunks: true,
})
  .extend({ kind: z.enum(["fulltext", "abstract", "note"]) })
  .strict()
export const MaterialDecision = z
  .object({
    action: z.enum([
      "start",
      "resume",
      "cancel",
      "answer",
      "select_ideas",
      "approve_protocol",
      "analyze",
      "revise_protocol",
      "refresh_literature",
    ]),
    revision: z.number().int(),
    answers: z.string().max(20_000).optional(),
    ideaIDs: z.array(z.string()).optional(),
    protocolID: z.string().optional(),
  })
  .strict()
export const MaterialBatchInput = MaterialBatch.omit({ id: true, createdAt: true })
  .extend({ revision: z.number().int() })
  .strict()
export const materialStages: MaterialStage[] = ["intake", "literature", "strategies", "ideas", "protocol", "analysis"]
