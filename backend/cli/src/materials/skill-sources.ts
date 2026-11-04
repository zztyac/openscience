import z from "zod"
import type { ConnectorHit } from "../science/connectors/types"
import { getJSON, HttpStatusError, SourceResponseError } from "../science/connectors/http"
import { arxiv } from "../science/connectors/literature/arxiv"
import { openalex } from "../science/connectors/literature/openalex"
import { fromInverted } from "../science/connectors/literature/shared"

export const MATERIAL_RETRIEVAL_SKILLS = [
  "arxiv",
  "deepxiv",
  "exa-search",
  "openalex",
  "research-lit",
  "semantic-scholar",
] as const
export type MaterialRetrievalSkill = (typeof MATERIAL_RETRIEVAL_SKILLS)[number]

export function skillAvailability(name: string): { available: boolean; reason?: string } {
  if (!MATERIAL_RETRIEVAL_SKILLS.includes(name as MaterialRetrievalSkill))
    return { available: false, reason: "此 Skill 尚未提供材料工作流执行适配。" }
  if (name === "exa-search" && !process.env.EXA_API_KEY?.trim())
    return { available: false, reason: "请先在凭据设置中配置 Exa API Key（EXA_API_KEY）。" }
  if (name === "deepxiv" && !(process.env.DEEPXIV_API_KEY?.trim() || process.env.DEEPXIV_TOKEN?.trim()))
    return { available: false, reason: "请先在凭据设置中配置 DeepXiv API Key（DEEPXIV_API_KEY）。" }
  return { available: true }
}

const Input = z.object({
  skill: z.enum(MATERIAL_RETRIEVAL_SKILLS),
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(6),
})
const Record = z.record(z.string(), z.unknown())
const S2 = "https://api.semanticscholar.org/graph/v1/paper"
const S2_FIELDS = "title,abstract,url,year,venue,citationCount,externalIds,authors.name,openAccessPdf"

function arxivQuery(query: string) {
  const outside = query.replace(/"(?:\\.|[^"\\])*"/g, " ")
  if (
    /(?:^|[\s(])(?:ti|au|abs|co|jr|cat|rn|id|all|submittedDate|lastUpdatedDate):/i.test(outside) ||
    /\b(?:AND|OR|ANDNOT|NOT)\b/.test(outside) ||
    /[()]/.test(outside)
  )
    return query
  // A single all: prefix does not bind every bare term. Keep quoted phrases
  // together and require each material/measurement keyword for plain searches.
  const terms = query.match(/"(?:\\.|[^"\\])*"|[^\s"]+/g) ?? []
  if (outside.includes('"')) throw new Error("arXiv 检索短语的引号未配对，请补齐引号后重试。")
  return terms.map((term) => `all:${term}`).join(" AND ")
}

function record(value: unknown): { [key: string]: unknown } {
  const parsed = Record.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function url(value: unknown) {
  const raw = text(value)
  if (!raw) return
  try {
    const parsed = new URL(raw)
    return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : undefined
  } catch {
    return
  }
}

function doi(value: unknown) {
  const raw = text(value)
    ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
  return raw && /^10\.\d{4,9}\/\S+$/i.test(raw) ? raw : undefined
}

function arxivID(value: unknown) {
  const raw = text(value)
    ?.replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/^arxiv:/i, "")
    .replace(/\.pdf$/i, "")
  return raw && /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(raw) ? raw : undefined
}

function names(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((author) => text(author) ?? text(record(author).name) ?? text(record(record(author).author).display_name))
        .filter((name): name is string => !!name)
        .join(", ") || undefined
    : text(value)
}

function year(value: unknown) {
  const parsed = typeof value === "string" ? Number(value.slice(0, 4)) : value
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1600 && parsed <= 2200 ? parsed : undefined
}

function normalize(
  hit: ConnectorHit,
  source: Exclude<MaterialRetrievalSkill, "research-lit">,
  skill: MaterialRetrievalSkill,
): ConnectorHit {
  const raw = hit.extra ?? {}
  const external = record(raw.externalIds)
  const id =
    arxivID(external.ArXiv) ??
    arxivID(raw.arxiv_id) ??
    (source === "arxiv" ? arxivID(hit.id) : undefined) ??
    arxivID(hit.url)
  const identifier = doi(raw.doi) ?? doi(external.DOI) ?? doi(hit.url)
  const locations = [
    record(raw.primary_location),
    record(raw.best_oa_location),
    ...(Array.isArray(raw.locations) ? raw.locations.map(record) : []),
  ]
  const pdfs = [
    raw.pdf,
    raw.pdf_url,
    record(raw.openAccessPdf).url,
    ...locations.map((item) => item.pdf_url),
    ...(id ? [`https://arxiv.org/pdf/${id}`] : []),
  ]
    .map(url)
    .filter((value): value is string => !!value)
  const abstract =
    source === "openalex"
      ? fromInverted(z.record(z.string(), z.array(z.number())).nullable().optional().parse(raw.abstract_inverted_index))
      : source === "arxiv"
        ? text(raw.summary)
        : source === "exa-search"
          ? undefined
          : text(raw.abstract)
  return {
    ...hit,
    extra: {
      ...raw,
      materialSkill: skill,
      materialSource: source,
      materialPaper: {
        doi: identifier,
        arxiv: id,
        abstract,
        authors: names(raw.authors ?? raw.authorships ?? raw.author),
        year: year(
          raw.year ?? raw.publication_year ?? raw.published ?? raw.publishedDate ?? raw.publish_at ?? raw.date,
        ),
        pdfURLs: [...new Set(pdfs)],
      },
    },
  }
}

function scholarlyHit(value: unknown): ConnectorHit | undefined {
  const raw = record(value)
  const title = text(raw.title)
  const id = text(raw.paperId) ?? text(raw.arxiv_id) ?? text(raw.id)
  if (!title || !id) return
  return {
    id,
    title,
    url:
      url(raw.url) ??
      (text(raw.paperId) ? `https://www.semanticscholar.org/paper/${encodeURIComponent(id)}` : undefined),
    summary: text(raw.abstract),
    score: typeof raw.citationCount === "number" ? raw.citationCount : undefined,
    extra: raw,
  }
}

function list(value: unknown, key: string): unknown[] {
  const items = record(value)[key]
  if (!Array.isArray(items)) throw new SourceResponseError("文献来源返回的结果结构无效，未将其加入证据库。")
  return items
}

function merge(hits: ConnectorHit[]) {
  const output: ConnectorHit[] = []
  for (const hit of hits) {
    const paper = record(hit.extra?.materialPaper)
    const index = output.findIndex((item) => {
      const previous = record(item.extra?.materialPaper)
      if (paper.doi && previous.doi) return String(paper.doi).toLowerCase() === String(previous.doi).toLowerCase()
      if (paper.arxiv && previous.arxiv)
        return String(paper.arxiv).replace(/v\d+$/i, "") === String(previous.arxiv).replace(/v\d+$/i, "")
      return hit.title.toLowerCase().replace(/\s+/g, " ") === item.title.toLowerCase().replace(/\s+/g, " ")
    })
    if (index === -1) {
      output.push(hit)
      continue
    }
    const previous = output[index]
    const before = record(previous.extra?.materialPaper)
    const preferred = hit.extra?.materialSource === "semantic-scholar" ? hit : previous
    output[index] = {
      ...preferred,
      extra: {
        ...preferred.extra,
        materialPaper: {
          ...Object.fromEntries(Object.entries(before).filter(([, value]) => value !== undefined)),
          ...Object.fromEntries(Object.entries(paper).filter(([, value]) => value !== undefined)),
          pdfURLs: [
            ...new Set([
              ...(Array.isArray(before.pdfURLs) ? before.pdfURLs : []),
              ...(Array.isArray(paper.pdfURLs) ? paper.pdfURLs : []),
            ]),
          ],
        },
      },
    }
  }
  return output
}

async function semantic(query: string, limit: number, signal: AbortSignal) {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()
  const response = await getJSON(`${S2}/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${S2_FIELDS}`, {
    signal,
    headers: key ? { "x-api-key": key } : undefined,
    rateLimit: { minIntervalMs: 1000 },
  })
  return list(response, "data")
    .map(scholarlyHit)
    .filter((hit): hit is ConnectorHit => !!hit)
}

async function exa(query: string, limit: number, signal: AbortSignal) {
  const response = await getJSON("https://api.exa.ai/search", {
    method: "POST",
    signal,
    retries: 0,
    headers: { "x-api-key": process.env.EXA_API_KEY!.trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, numResults: limit, type: "auto", category: "research paper" }),
  })
  return list(response, "results").flatMap((value) => {
    const raw = record(value)
    const target = url(raw.url)
    const title = text(raw.title)
    if (!target || !title) return []
    // Web extracts and generated summaries are discovery hints, not paper abstracts.
    return [
      {
        id: text(raw.id) ?? target,
        title,
        url: target,
        extra: {
          author: raw.author,
          publishedDate: raw.publishedDate,
          doi: doi(target),
          ...(new URL(target).pathname.toLowerCase().endsWith(".pdf") ? { pdf_url: target } : {}),
        },
      },
    ]
  })
}

async function deepxiv(query: string, limit: number, signal: AbortSignal): Promise<ConnectorHit[]> {
  if (query.length > 500) throw new Error("DeepXiv 单次检索词最多 500 个字符，请缩短检索词。")
  // Reader.search in the public deepxiv-sdk 1.2.2 uses this retrieval API.
  // Header authentication avoids placing the credential in persisted URLs.
  const params = new URLSearchParams({
    type: "retrieve",
    query,
    source: "arxiv",
    top_k: String(limit),
    offset: "0",
    use_fine_rerank: "false",
  })
  const response = await getJSON(`https://data.rag.ac.cn/arxiv/?${params}`, {
    signal,
    headers: { Authorization: `Bearer ${process.env.DEEPXIV_API_KEY?.trim() || process.env.DEEPXIV_TOKEN?.trim()}` },
    rateLimit: { minIntervalMs: 1000 },
  })
  if (record(response).status !== "success") throw new SourceResponseError("DeepXiv 未返回成功的检索结果。")
  return list(response, "result").flatMap((value) => {
    const raw = record(value)
    const id = arxivID(raw.arxiv_id)
    const title = text(raw.title)
    if (!id || !title) return []
    // Deliberately keep original abstract only; tldr/brief is generated text.
    return [
      {
        id,
        title,
        url: `https://arxiv.org/abs/${id}`,
        summary: text(raw.abstract),
        extra: {
          arxiv_id: id,
          abstract: text(raw.abstract),
          authors: raw.authors,
          publish_at: raw.publish_at ?? raw.date,
          doi: raw.doi,
          venue: raw.venue,
        },
      },
    ]
  })
}

export async function searchSkillPapers(input: {
  skill: string
  query: string
  limit?: number
  signal: AbortSignal
}): Promise<ConnectorHit[]> {
  const parsed = Input.parse(input)
  input.signal.throwIfAborted()
  const availability = skillAvailability(parsed.skill)
  if (!availability.available) throw new Error(availability.reason)
  if (parsed.skill === "research-lit") {
    const sources = ["arxiv", "openalex", "semantic-scholar"] as const
    const results = await Promise.allSettled(
      sources.map((skill) => searchSkillPapers({ ...parsed, skill, signal: input.signal })),
    )
    input.signal.throwIfAborted()
    const successful = results.filter((result) => result.status === "fulfilled")
    if (!successful.length) throw new SourceResponseError("综合文献检索的所有来源均未成功，请检查网络或来源凭据。")
    const warnings = results.flatMap((result, index) =>
      result.status === "rejected" ? [`${sources[index]} 检索失败`] : [],
    )
    return merge(successful.flatMap((result) => result.value))
      .slice(0, parsed.limit)
      .map((hit) => ({ ...hit, extra: { ...hit.extra, materialSkill: parsed.skill, materialWarnings: warnings } }))
  }
  const hits =
    parsed.skill === "arxiv"
      ? await arxiv.search(arxivQuery(parsed.query), { limit: parsed.limit, signal: input.signal })
      : parsed.skill === "openalex"
        ? await openalex.search(parsed.query, { limit: parsed.limit, signal: input.signal })
        : parsed.skill === "semantic-scholar"
          ? await semantic(parsed.query, parsed.limit, input.signal)
          : parsed.skill === "exa-search"
            ? await exa(parsed.query, parsed.limit, input.signal)
            : await deepxiv(parsed.query, parsed.limit, input.signal)
  input.signal.throwIfAborted()
  return hits
    .slice(0, parsed.limit)
    .map((hit) => normalize(hit, parsed.skill as Exclude<MaterialRetrievalSkill, "research-lit">, parsed.skill))
}

export async function lookupSkillPaper(input: {
  skill: string
  reference: string
  signal: AbortSignal
}): Promise<ConnectorHit | undefined> {
  const skill = z.enum(MATERIAL_RETRIEVAL_SKILLS).parse(input.skill)
  const reference = z.string().trim().min(1).max(2000).parse(input.reference)
  input.signal.throwIfAborted()
  const availability = skillAvailability(skill)
  if (!availability.available) throw new Error(availability.reason)
  const identifier = doi(reference)
  const id = arxivID(reference)
  if (skill === "research-lit" && (identifier || id)) {
    const sources = id ? ["arxiv", "semantic-scholar"] : ["openalex", "semantic-scholar"]
    const results = await Promise.allSettled(sources.map((source) => lookupSkillPaper({ ...input, skill: source })))
    input.signal.throwIfAborted()
    if (results.every((result) => result.status === "rejected"))
      throw new SourceResponseError("综合文献查询的所有来源均未成功，请稍后重试。")
    const hits = results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []))
    const hit = merge(hits)[0]
    return hit ? { ...hit, extra: { ...hit.extra, materialSkill: skill } } : undefined
  }
  try {
    if (skill === "openalex" && (identifier || /^W\d+$/.test(reference))) {
      const raw = record(await openalex.fetch(identifier ?? reference, { signal: input.signal }))
      const title = text(raw.title ?? raw.display_name)
      if (!title) return
      return normalize(
        { id: text(raw.id) ?? reference, title, url: url(raw.id) ?? url(raw.doi), extra: raw },
        skill,
        skill,
      )
    }
    if (skill === "arxiv" && id) {
      const raw = record(await arxiv.fetch(id, { signal: input.signal }))
      const title = text(raw.title)
      if (!title) return
      return normalize({ id, title, url: `https://arxiv.org/abs/${id}`, extra: raw }, skill, skill)
    }
    if (skill === "semantic-scholar" && (identifier || id || /^[a-f0-9]{40}$/i.test(reference))) {
      const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()
      const external = identifier ? `DOI:${identifier}` : id ? `ARXIV:${id}` : reference
      const raw = await getJSON(`${S2}/${encodeURIComponent(external)}?fields=${S2_FIELDS}`, {
        signal: input.signal,
        headers: key ? { "x-api-key": key } : undefined,
        rateLimit: { minIntervalMs: 1000 },
      })
      const hit = scholarlyHit(raw)
      return hit ? normalize(hit, skill, skill) : undefined
    }
    if (skill === "deepxiv" && id) {
      const params = new URLSearchParams({ type: "head", arxiv_id: id })
      const raw = record(
        await getJSON(`https://data.rag.ac.cn/arxiv/?${params}`, {
          signal: input.signal,
          headers: {
            Authorization: `Bearer ${process.env.DEEPXIV_API_KEY?.trim() || process.env.DEEPXIV_TOKEN?.trim()}`,
          },
          rateLimit: { minIntervalMs: 1000 },
        }),
      )
      const title = text(raw.title)
      if (!title) return
      return normalize({ id, title, url: `https://arxiv.org/abs/${id}`, extra: { ...raw, arxiv_id: id } }, skill, skill)
    }
  } catch (error) {
    input.signal.throwIfAborted()
    if (error instanceof HttpStatusError && error.status === 404) return
    throw error
  }
  return undefined
}
