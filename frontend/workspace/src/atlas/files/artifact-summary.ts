import { extension, thumbLanguage } from "./artifact-thumb"
import type { MaterialStage } from "@synsci/util/materials"

export interface ArtifactSummary {
  kind: "document" | "structured"
  paragraphs: string[]
  count?: { kind: "items" | "fields"; value: number }
}

const MAX_TEXT = 64 * 1_024
const MAX_SUMMARY = 600
const MAX_PARAGRAPHS = 3

const plain = (text: string) =>
  text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, bold, strong) => bold ?? strong)
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

const compact = (parts: string[]) => {
  const result: string[] = []
  let remaining = MAX_SUMMARY
  for (const part of parts) {
    const text = plain(part)
    if (!text || result.includes(text)) continue
    const available = Math.min(remaining, 280)
    result.push(text.length > available ? `${text.slice(0, available - 1).trimEnd()}…` : text)
    remaining -= result.at(-1)!.length
    if (result.length === MAX_PARAGRAPHS || remaining < 40) break
  }
  return result
}

/** Excerpts only: never infer a result or execute document markup. */
export function markdownSummary(body: string): ArtifactSummary {
  const text = body
    .slice(0, MAX_TEXT)
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[^]*?\n---(?:\n|$)/, "")
  const paragraphs = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .filter((line) => !/^\s{0,3}#{1,6}\s|^\s*(?:[-=*]\s*){3,}$|^\s*\[[^\]]+\]:\s/.test(line))
        .filter((line) => !/^\s*\|?\s*:?-{3,}.*\|/.test(line))
        .map((line) => line.replace(/^\s*(?:>\s*|[-+*]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, ""))
        .join(" "),
    )
  return { kind: "document", paragraphs: compact(paragraphs) }
}

/** Known report sections provide excerpts without rewriting the scientific record. */
function materialSummary(body: string, stage: MaterialStage): ArtifactSummary | undefined {
  const text = body.slice(0, MAX_TEXT).replace(/\r\n?/g, "\n")
  if (stage === "ideas") {
    const heading = /^##\s+\d+[.、)]\s+(.+)$/m.exec(text)
    if (!heading) return
    const section = text.slice(heading.index + heading[0].length).split(/^#{1,6}\s+/m)[0]
    const hypothesis = markdownSummary(section).paragraphs[0]
    if (!hypothesis) return
    return { kind: "document", paragraphs: compact([heading[1], hypothesis]) }
  }
  if (stage === "strategies") {
    const excerpt = text.replace(/^\s*(?:来源|Source)\s*[:：]\s*`?src_[a-zA-Z0-9_]+`?\s*$/gm, "")
    return markdownSummary(excerpt)
  }
  if (stage === "protocol") {
    const title = /^#\s+(.+)$/m.exec(text)?.[1]
    const heading = /^##\s+(?:实验分组|Experimental groups)\s*$/im.exec(text)
    if (!title || !heading) return
    const section = text.slice(heading.index + heading[0].length).split(/^#{1,2}\s+/m)[0]
    const groups = section
      .split(/\n(?=\s*[-*+]\s)/)
      .map((group) => group.replace(/[（(](?:g|group)_[a-zA-Z0-9_]+[）)]/g, ""))
      .flatMap((group) => markdownSummary(group).paragraphs)
    if (!groups.length) return
    return { kind: "document", paragraphs: compact([title, ...groups]) }
  }
}

const preferred = [
  "summary",
  "objective",
  "goal",
  "hypothesis",
  "description",
  "abstract",
  "strategy",
  "design",
  "comparison",
  "rationale",
  "purpose",
  "instruction",
  "effect",
  "limitation",
  "expectation",
] as const
const metadata = /(?:^id$|id$|ids$|url|uri|path|sha|hash|mime|created|updated|status|decision|type|version)/i

export function structuredSummary(body: string): ArtifactSummary | undefined {
  if (body.length > MAX_TEXT) return
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return
  }
  const excerpts: string[] = []
  let visited = 0
  const collect = (item: unknown, depth: number) => {
    if (depth > 6 || visited++ > 150 || excerpts.length >= MAX_PARAGRAPHS) return
    if (typeof item === "string") {
      if (item.trim()) excerpts.push(item)
      return
    }
    if (!item || typeof item !== "object") return
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 12)) collect(child, depth + 1)
      return
    }
    const record = item as Record<string, unknown>
    const keys = Object.keys(record)
    const selected = preferred.filter((key) => typeof record[key] === "string" && record[key])
    for (const key of selected.slice(0, 2)) collect(record[key], depth + 1)
    for (const key of keys) {
      if (!metadata.test(key) && typeof record[key] === "object") collect(record[key], depth + 1)
    }
    // Human-authored titles remain useful when the object contains no prose.
    if (!selected.length && excerpts.length < MAX_PARAGRAPHS) {
      const fallback = keys.find(
        (key) => !metadata.test(key) && typeof record[key] === "string" && String(record[key]).trim().length > 2,
      )
      if (fallback) collect(record[fallback], depth + 1)
    }
  }
  collect(value, 0)
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  const array = Array.isArray(value) ? value : record ? Object.values(record).find(Array.isArray) : undefined
  return {
    kind: "structured",
    paragraphs: compact(excerpts),
    ...(array
      ? { count: { kind: "items" as const, value: array.length } }
      : record
        ? { count: { kind: "fields" as const, value: Object.keys(record).length } }
        : {}),
  }
}

export function artifactSummary(
  body: string,
  filename: string,
  mimeType: string,
  stage?: MaterialStage,
): ArtifactSummary | undefined {
  const ext = extension(filename)
  if (["md", "markdown", "mdown", "rmd", "qmd"].includes(ext) || mimeType.includes("markdown"))
    return (stage && materialSummary(body, stage)) || markdownSummary(body)
  if (ext === "json" || mimeType.includes("json")) return structuredSummary(body)
  if (["txt", "log"].includes(ext) || (mimeType.startsWith("text/plain") && thumbLanguage(filename) === "text")) {
    return { kind: "document", paragraphs: compact(body.slice(0, MAX_TEXT).split(/\r?\n\s*\r?\n/)) }
  }
}
