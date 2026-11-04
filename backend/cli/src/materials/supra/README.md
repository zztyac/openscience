# SupraMAS domain provenance

The two JSON schemas in this directory are unmodified reference copies from the
user-provided `SupraMAS_V2_new` project, `schemas/strategy_tree.schema.json` and
`schemas/idea_design.schema.json`, copied on 2026-10-25. They document the original
Stage 1 and Stage 2 formats; they are **not** the API contract of this workbench.
The workbench uses the versioned project/artifact records and Zod types in
`tooling/util/src/materials.ts`, with additional evidence/relationship validation
in `backend/cli/src/materials/validation.ts`.

`domain.ts` adapts domain rules from these original source documents:

- `agents/task-setup-agent.md` (Stage 0 clarification)
- `agents/strategy-builder-agent.md`
- `agents/strategy-tree-reviewer.md`
- `.codex/skills/superconducting-materials-idea-expert/SKILL.md`
- `.codex/skills/stage2-idea-design-loop/SKILL.md`
- `.codex/skills/stage2-idea-review/SKILL.md`
- `.codex/skills/stage2-idea-proximity/SKILL.md`
- `.codex/skills/stage2-idea-ranking/SKILL.md`
- `.codex/skills/stage2-idea-evolution/SKILL.md`

The migration preserves one paper per node, separate strategy and limitation
records, the five tuning dimensions, limitation-driven edges, review-gated idea
design, source-grounded evidence, and the distinction between literature facts
and inferred designs. The workbench stores exact source text and checks normalized
quotes against it. Abstract-only sources are explicitly qualified, and personal
notes cannot stand in for paper evidence. Unlike the original default full-text
policy, qualified abstract-only nodes can be used for an exploratory first pass.

The compact workbench schema does not reproduce every legacy field (for example,
chunk-level confidence and the entire similarity graph). Review/ranking/evolution
decisions must be recorded in current artifacts; prompt instructions alone do not
prove that independent reviewers or a full legacy loop have run.

The protocol and manual-data-analysis stages are new workbench behavior, beyond
the original Stage 2 boundary. Protocols require human confirmation; the software
does not carry out physical experiments or claim that generated designs have
been experimentally validated.

No configuration, credentials, run data, personal papers, or Codex session logs
were copied. No license file was found in the supplied source tree during this
migration, so these copies retain their source attribution and do not assert a
new upstream license. The original authors' rights remain with their owners.
