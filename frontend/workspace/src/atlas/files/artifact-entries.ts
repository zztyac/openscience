import type { StoredArtifact } from "@/artifacts/store"
import type { MaterialStage } from "@synsci/util/materials"

export interface MaterialArtifactInfo {
  projectID: string
  sessionID: string
  materialID: string
  stage: MaterialStage
  format: "md" | "json"
}

export interface ArtifactEntry {
  artifact: StoredArtifact
  companion?: StoredArtifact
  material?: MaterialArtifactInfo
}

const titles: Record<MaterialStage, string> = {
  intake: "研究目标与任务范围",
  literature: "文献与证据库",
  strategies: "文献策略树",
  ideas: "创新方案与评审",
  protocol: "实验方案草案",
  analysis: "实验结果与下一轮建议",
}

export function materialArtifact(artifact: StoredArtifact): MaterialArtifactInfo | undefined {
  if (
    artifact.state !== "active" ||
    !artifact.projectID ||
    !artifact.current.sessionID ||
    artifact.currentVersionID !== artifact.current.id ||
    artifact.current.artifactID !== artifact.id
  )
    return
  const match =
    /^materials\/(mat_[a-zA-Z0-9]+)\/reports\/(intake|literature|strategies|ideas|protocol|analysis)\.(md|json)$/.exec(
      artifact.current.sourcePath,
    )
  if (!match) return
  const format = match[3] as MaterialArtifactInfo["format"]
  const mime = artifact.current.mimeType.split(";")[0].trim().toLowerCase()
  if (mime !== (format === "md" ? "text/markdown" : "application/json")) return
  return {
    projectID: artifact.projectID,
    sessionID: artifact.current.sessionID,
    materialID: match[1],
    stage: match[2] as MaterialStage,
    format,
  }
}

/** Group only an unambiguous current report and dataset; retain their original identities for actions. */
export function artifactEntries(list: readonly StoredArtifact[]): ArtifactEntry[] {
  const entries = list.map((artifact): ArtifactEntry => ({ artifact, material: materialArtifact(artifact) }))
  const groups = new Map<string, ArtifactEntry[]>()
  for (const entry of entries) {
    const info = entry.material
    if (!info) continue
    const key = JSON.stringify([info.projectID, info.sessionID, info.materialID, info.stage])
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }
  const pairs = new Map<StoredArtifact, ArtifactEntry>()
  for (const group of groups.values()) {
    if (group.length !== 2) continue
    const report = group.find((entry) => entry.material?.format === "md")
    const data = group.find((entry) => entry.material?.format === "json")
    if (!report || !data || report.artifact.id === data.artifact.id) continue
    const paired = { ...report, companion: data.artifact }
    pairs.set(report.artifact, paired)
    pairs.set(data.artifact, paired)
  }
  const emitted = new Set<ArtifactEntry>()
  return entries.flatMap((entry) => {
    const paired = pairs.get(entry.artifact)
    if (!paired) return [entry]
    if (emitted.has(paired)) return []
    emitted.add(paired)
    return [paired]
  })
}

/** Only the workflow's known generated suffix is shortened. Custom titles stay verbatim. */
export function artifactLabel(artifact: StoredArtifact): { title: string; topic?: string } {
  const info = materialArtifact(artifact)
  if (!info) return { title: artifact.title }
  const title = titles[info.stage]
  const suffix = ` · ${title}${info.format === "json" ? "（结构化数据）" : ""}`
  if (!artifact.title.endsWith(suffix)) return { title: artifact.title }
  const topic = artifact.title.slice(0, -suffix.length)
  if (!topic.trim()) return { title: artifact.title }
  return { title, topic }
}

/** Apply search after pairing so a match on the data title still includes its report. */
export function matchesArtifactEntry(entry: ArtifactEntry, query: string): boolean {
  const search = query.trim().toLowerCase()
  return !search || [entry.artifact, entry.companion].some((artifact) => artifact?.title.toLowerCase().includes(search))
}
