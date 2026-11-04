import { describe, expect, test } from "bun:test"
import type { StoredArtifact } from "@/artifacts/store"
import { artifactEntries, artifactLabel, materialArtifact, matchesArtifactEntry } from "./artifact-entries"

function artifact(id: string, format: "md" | "json", over: Partial<StoredArtifact> = {}): StoredArtifact {
  return {
    schemaVersion: 1,
    id,
    projectID: "prj_1",
    title: `REBCO 薄膜 · 创新方案与评审${format === "json" ? "（结构化数据）" : ""}`,
    kind: format === "md" ? "report" : "dataset",
    currentVersionID: `ver_${id}`,
    createdAt: 10,
    updatedAt: 10,
    state: "active",
    versionCount: 1,
    current: {
      id: `ver_${id}`,
      artifactID: id,
      version: 1,
      filename: `ideas.${format}`,
      mimeType: format === "md" ? "text/markdown" : "application/json",
      size: 100,
      sha256: id,
      sessionID: "ses_1",
      sourcePath: `materials/mat_abc123/reports/ideas.${format}`,
      captureQuality: "declared",
      createdAt: 10,
    },
    ...over,
  }
}

describe("material result entries", () => {
  test("pairs current report and data by provenance while preserving action identities and input order", () => {
    const report = artifact("art_md", "md", { title: "用户重命名的实验想法" })
    const data = artifact("art_json", "json")
    const other = artifact("art_other", "md", { projectID: "prj_other" })
    const list = [other, data, report]
    const entries = artifactEntries(list)
    expect(entries).toHaveLength(2)
    expect(entries[0].artifact).toBe(other)
    expect(entries[1].artifact).toBe(report)
    expect(entries[1].companion).toBe(data)
    expect(entries[1].material).toEqual({
      projectID: "prj_1",
      sessionID: "ses_1",
      materialID: "mat_abc123",
      stage: "ideas",
      format: "md",
    })
    expect(list).toEqual([other, data, report])
  })

  test("does not merge identical titles across project, session, material or stage boundaries", () => {
    const report = artifact("art_md", "md")
    const data = artifact("art_json", "json")
    const different = [
      { ...data, projectID: "prj_2" },
      { ...data, current: { ...data.current, sessionID: "ses_2" } },
      { ...data, current: { ...data.current, sourcePath: "materials/mat_other/reports/ideas.json" } },
      { ...data, current: { ...data.current, sourcePath: "materials/mat_abc123/reports/protocol.json" } },
    ]
    for (const item of different) {
      const entries = artifactEntries([report, item])
      expect(entries).toHaveLength(2)
      expect(entries.every((entry) => !entry.companion)).toBe(true)
    }
  })

  test("keeps every artifact when more than one report or dataset makes a pair ambiguous", () => {
    const report = artifact("art_md", "md")
    const data = artifact("art_json", "json")
    for (const duplicate of [artifact("art_md2", "md"), artifact("art_json2", "json")]) {
      const entries = artifactEntries([report, data, duplicate])
      expect(entries.map((entry) => entry.artifact)).toEqual([report, data, duplicate])
      expect(entries.every((entry) => !entry.companion)).toBe(true)
    }
    expect(artifactEntries([report, artifact("art_md", "json")])).toHaveLength(2)
  })

  test("keeps standalone JSON and ordinary files available", () => {
    const data = artifact("art_json", "json")
    const plain = artifact("art_plain", "md")
    plain.current.sourcePath = "/tmp/ideas.md"
    const entries = artifactEntries([data, plain])
    expect(entries.map((entry) => entry.artifact)).toEqual([data, plain])
    expect(entries[0].material?.format).toBe("json")
    expect(entries[1].material).toBeUndefined()
  })

  test("never treats historical, malformed or unrelated source paths as a workflow result", () => {
    for (const sourcePath of [
      "materials/mat_abc123/reports/ideas/v1.md",
      "/tmp/materials/mat_abc123/reports/ideas.md",
      "materials/mat_abc123/reports/unknown.md",
      "materials/../reports/ideas.md",
      "materials/mat_abc123/reports/ideas.md/extra",
      "materials/mat_abc123/reports/ideas.md?version=1",
      "materials\\mat_abc123\\reports\\ideas.md",
    ]) {
      const report = artifact("art_md", "md")
      report.current.sourcePath = sourcePath
      expect(materialArtifact(report)).toBeUndefined()
    }
  })

  test("does not pair stale, trashed, inconsistent or incorrectly typed snapshots", () => {
    const report = artifact("art_md", "md")
    const data = artifact("art_json", "json")
    const invalid = [
      { ...data, currentVersionID: "ver_older" },
      { ...data, state: "trash" as const },
      { ...data, projectID: "" },
      { ...data, current: { ...data.current, artifactID: "art_other" } },
      { ...data, current: { ...data.current, sessionID: "" } },
      { ...data, current: { ...data.current, mimeType: "text/markdown" } },
    ]
    for (const item of invalid) {
      expect(materialArtifact(item)).toBeUndefined()
      expect(artifactEntries([report, item])).toHaveLength(2)
    }
  })

  test("recognizes a current result with MIME parameters without requiring equal storage version numbers", () => {
    const report = artifact("art_md", "md")
    report.current.mimeType = "text/markdown; charset=utf-8"
    report.current.version = 3
    const entries = artifactEntries([report, artifact("art_json", "json")])
    expect(entries).toHaveLength(1)
    expect(entries[0].companion?.id).toBe("art_json")
  })

  test("searching only a companion title retains the report and its independent data action", () => {
    const report = artifact("art_md", "md")
    const data = artifact("art_json", "json", { title: "custom DATA" })
    const entries = artifactEntries([report, data])
    expect(entries.filter((entry) => matchesArtifactEntry(entry, "  data  "))).toEqual(entries)
    expect(entries.filter((entry) => matchesArtifactEntry(entry, "REBCO"))).toEqual(entries)
    expect(entries.filter((entry) => matchesArtifactEntry(entry, "unknown"))).toHaveLength(0)
    expect(matchesArtifactEntry(entries[0], "  ")).toBe(true)
    expect(artifactEntries([data])[0].artifact).toBe(data)
  })
})

describe("material result labels", () => {
  test("separates a generated title into topic and stage, including topics containing separators", () => {
    const report = artifact("art_md", "md", { title: "REBCO · BZO · 创新方案与评审" })
    expect(artifactLabel(report)).toEqual({ title: "创新方案与评审", topic: "REBCO · BZO" })
    expect(artifactLabel(artifact("art_json", "json"))).toEqual({ title: "创新方案与评审", topic: "REBCO 薄膜" })
  })

  test("preserves custom labels and titles on unrelated artifacts verbatim", () => {
    for (const title of ["用户指定名称", "方案 · 最终稿", "课题 · 实验方案草案", " · 创新方案与评审"]) {
      expect(artifactLabel(artifact("art_md", "md", { title }))).toEqual({ title })
    }
    const plain = artifact("art_plain", "md")
    plain.current.sourcePath = "/tmp/ideas.md"
    expect(artifactLabel(plain)).toEqual({ title: plain.title })
    expect(artifactLabel(artifact("art_json", "json", { title: "REBCO · 创新方案与评审" }))).toEqual({
      title: "REBCO · 创新方案与评审",
    })
  })
})
