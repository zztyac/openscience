import z from "zod"
import { createHash } from "node:crypto"
import { MaterialIntake, MaterialSource, type MaterialProject, type MaterialReporter } from "@synsci/util/materials"
import { openalex } from "../science/connectors/literature/openalex"
import { crossref } from "../science/connectors/literature/crossref"
import { fromInverted, stripTags } from "../science/connectors/literature/shared"
import type { Connector, ConnectorHit } from "../science/connectors/types"
import { Network } from "../settings/network"
import { HttpStatusError, SourceResponseError } from "../science/connectors/http"
import { enrichFulltext } from "./fulltext"

const OpenAlexRecord = z.object({
  doi: z.string().nullable().optional(),
  publication_year: z.number().optional(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
  authorships: z.array(z.object({ author: z.object({ display_name: z.string().optional() }).optional() })).optional(),
})
const CrossrefRecord = z.object({
  DOI: z.string().optional(),
  abstract: z.string().optional(),
  author: z
    .array(z.object({ given: z.string().optional(), family: z.string().optional(), name: z.string().optional() }))
    .optional(),
  issued: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
})

function candidateFromHit(hit: ConnectorHit, origin: "openalex" | "crossref"): MaterialSource | undefined {
  const record = origin === "openalex" ? OpenAlexRecord.safeParse(hit.extra) : CrossrefRecord.safeParse(hit.extra)
  if (!record.success) return
  const oa = origin === "openalex" ? OpenAlexRecord.parse(record.data) : undefined
  const cr = origin === "crossref" ? CrossrefRecord.parse(record.data) : undefined
  // Search snippets may contain author/venue metadata when no abstract exists.
  // Only a real upstream abstract is eligible as scientific evidence.
  const text = oa ? fromInverted(oa.abstract_inverted_index) : stripTags(cr?.abstract)
  const doi = (oa?.doi ?? cr?.DOI)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
  if (!doi && !hit.id.trim()) return
  const key = doi?.toLowerCase() || `${origin}:${hit.id}`
  const authors = oa
    ? (oa.authorships ?? [])
        .map((entry) => entry.author?.display_name)
        .filter(Boolean)
        .join(", ")
    : (cr?.author ?? []).map((entry) => entry.name ?? [entry.given, entry.family].filter(Boolean).join(" ")).join(", ")
  // Metadata-only hits remain private candidates until a real abstract or PDF
  // has been obtained. A search snippet must never become scientific evidence.
  const result = MaterialSource.extend({ text: z.string().max(200_000) }).safeParse({
    id: `src_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`,
    title: hit.title,
    authors: authors.length > 2000 ? `${authors.slice(0, 1999)}…` : authors,
    doi,
    url: hit.url && /^https?:\/\//i.test(hit.url) ? hit.url : undefined,
    year: oa?.publication_year ?? cr?.issued?.["date-parts"]?.[0]?.[0],
    kind: "abstract",
    text: text && text.length >= 40 ? text.slice(0, 200_000) : "",
    origin,
    createdAt: Date.now(),
  })
  return result.success ? result.data : undefined
}

export function sourceFromHit(hit: ConnectorHit, origin: "openalex" | "crossref"): MaterialSource | undefined {
  const candidate = candidateFromHit(hit, origin)
  return candidate?.text ? candidate : undefined
}

export function failureReason(error: unknown) {
  if (error instanceof Network.PolicyError) return "网络策略拦截了来源请求，请检查服务器网络白名单或代理 DNS 配置"
  if (error instanceof Network.ResolutionError)
    return error.code === "DNS_TIMEOUT"
      ? "DNS 解析超时，请检查服务器 DNS 服务是否可连接"
      : "DNS 解析失败，请检查服务器 DNS 配置及解析服务可用性"
  if (error instanceof HttpStatusError) {
    if (error.status === 429) {
      const wait = error.retryAfterMs
      return typeof wait === "number" && Number.isFinite(wait) && wait > 0
        ? `来源服务限流（HTTP 429），请至少等待 ${Math.ceil(wait / 1000)} 秒后重试`
        : "来源服务限流（HTTP 429），请稍后重试"
    }
    if (error.status === 401) return "来源身份验证失败（HTTP 401），请检查该文献来源的凭据"
    if (error.status === 403) return "来源拒绝访问（HTTP 403），请检查访问权限或来源服务限制"
    if (error.status === 408) return "来源请求超时（HTTP 408），请稍后重试"
    if (error.status >= 500 && error.status <= 599) return `来源服务器暂时异常（HTTP ${error.status}），请稍后重试`
    return "来源未能处理检索请求，请检查检索条件或稍后重试"
  }
  if (error instanceof SourceResponseError) return "来源返回了异常内容（可能是验证页面或服务错误），未将其作为论文证据"
  if (error instanceof SyntaxError) return "来源返回的内容不是有效 JSON，未将其作为论文证据"
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
    return "来源请求超时，请检查网络后重试"
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS 解析失败，请检查服务器 DNS 配置及解析服务可用性"
  if (code === "ETIMEDOUT") return "来源连接超时，请检查服务器网络或代理连接"
  if (["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"].includes(String(code)))
    return "无法连接来源服务，请检查服务器网络或代理连接后重试"
  if (
    [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(String(code))
  )
    return "来源安全连接校验失败，请检查服务器证书信任与代理配置"
  return "来源暂时不可用，请检查网络或稍后重试"
}

export async function collectLiterature(
  project: MaterialProject,
  signal: AbortSignal,
  connectors: Array<Pick<Connector, "search"> & { id: "openalex" | "crossref" }> = [
    { id: "openalex", search: openalex.search },
    { id: "crossref", search: crossref.search },
  ],
  enrich: typeof enrichFulltext = enrichFulltext,
  report?: MaterialReporter,
) {
  signal.throwIfAborted()
  const intake = project.artifacts.findLast((artifact) => artifact.stage === "intake")
  const queries = intake
    ? MaterialIntake.parse(intake.data).searchQueries
    : ["REBCO thin film flux pinning critical current density"]
  const sources = [...project.sources]
  const gaps: string[] = []
  const paused = new Map<string, number>()
  if (sources.filter((source) => source.kind === "fulltext").length < 2 && sources.length < 12) {
    for (const query of queries.slice(0, 2)) {
      signal.throwIfAborted()
      const available = connectors.filter((connector) => (paused.get(connector.id) ?? 0) <= Date.now())
      if (!available.length) break
      report?.({
        phase: "searching",
        role: "literature-search",
        item: `${available.map((connector) => (connector.id === "openalex" ? "OpenAlex" : "Crossref")).join(" / ")} · ${query}`.slice(
          0,
          500,
        ),
      })
      const results = await Promise.allSettled(
        available.map(async (connector) => ({
          origin: connector.id,
          hits: await connector.search(query, {
            limit: 6,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          }),
        })),
      )
      signal.throwIfAborted()
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          const connector = available[index]
          const error = result.reason
          // Do not immediately re-query a source after it denied access or
          // exhausted its retry budget. Known cooldowns may expire meanwhile.
          if (error instanceof HttpStatusError && [401, 403, 429].includes(error.status)) {
            const wait = error.retryAfterMs
            paused.set(
              connector.id,
              error.status === 429 && typeof wait === "number" && Number.isFinite(wait) && wait > 0
                ? Date.now() + wait
                : Infinity,
            )
          }
          gaps.push(
            `${connector.id === "openalex" ? "OpenAlex" : "Crossref"}：${failureReason(error)}；可上传论文原文补充证据。`,
          )
          continue
        }
        for (const hit of result.value.hits) {
          const source = candidateFromHit(hit, result.value.origin)
          if (!source) continue
          const duplicate = sources.findIndex(
            (existing) =>
              existing.id === source.id || (existing.doi && existing.doi.toLowerCase() === source.doi?.toLowerCase()),
          )
          if (duplicate !== -1) {
            // A metadata-only OpenAlex record must not hide the real abstract
            // returned for the same DOI by another source.
            if (
              !sources[duplicate].text &&
              source.text &&
              sources.reduce((sum, item) => sum + item.text.length, 0) + source.text.length <= 1_000_000
            )
              sources[duplicate] = source
            continue
          }
          if (
            sources.length >= 24 ||
            sources.reduce((length, item) => length + item.text.length, 0) + source.text.length > 1_000_000
          ) {
            gaps.push("部分检索结果超过课题来源数量或正文总长度限制，未加入本次证据集合。")
            continue
          }
          sources.push(source)
        }
      }
      if (sources.length >= 12) break
    }
  }
  const candidates = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.kind !== "fulltext" && ["openalex", "crossref"].includes(source.origin))
  // Allocate remaining capacity fairly before each bounded batch, so one long
  // paper cannot displace all later papers or an already uploaded source.
  for (let offset = 0; offset < candidates.length; offset += 2) {
    signal.throwIfAborted()
    const remaining = Math.max(0, 1_000_000 - sources.reduce((sum, source) => sum + source.text.length, 0))
    const share = Math.floor(remaining / (candidates.length - offset))
    const batch = candidates.slice(offset, offset + 2)
    report?.({
      phase: "retrieving",
      role: "fulltext-retrieval",
      completed: offset,
      total: candidates.length,
      item: batch
        .map(({ source }) => source.title)
        .join(" / ")
        .slice(0, 500),
    })
    const results = await Promise.allSettled(
      batch.map(({ source }) =>
        enrich(source, { projectID: project.id, signal, maxChars: Math.min(200_000, source.text.length + share) }),
      ),
    )
    signal.throwIfAborted()
    for (const [index, result] of results.entries()) {
      const candidate = batch[index]
      sources[candidate.index] =
        result.status === "fulfilled"
          ? result.value
          : {
              ...candidate.source,
              retrieval: {
                status: "unavailable",
                attemptedAt: Date.now(),
                reason: "全文处理暂时失败，可稍后重试或上传原文。",
              },
            }
    }
    report?.({
      phase: "retrieving",
      role: "fulltext-retrieval",
      completed: offset + batch.length,
      total: candidates.length,
      item: batch
        .map(({ source }) => source.title)
        .join(" / ")
        .slice(0, 500),
    })
  }
  report?.({ phase: "validating", role: "evidence-preparation" })
  // Failed downloads leave their fair share unused. Expand cached body text
  // into that space without repeating network requests or losing other papers.
  for (const [index, source] of sources.entries()) {
    if (source.kind !== "partial" || !["openalex", "crossref"].includes(source.origin)) continue
    const remaining = Math.max(0, 1_000_000 - sources.reduce((sum, item) => sum + item.text.length, 0))
    const maxChars = Math.min(200_000, source.text.length + remaining)
    if (maxChars <= source.text.length) continue
    signal.throwIfAborted()
    const expanded = await enrich(source, { projectID: project.id, signal, maxChars, cacheOnly: true }).catch(
      () => source,
    )
    signal.throwIfAborted()
    if (expanded.text.length >= source.text.length) sources[index] = expanded
  }
  const admitted = sources.filter((source) => source.text.length >= 20)
  for (const source of sources.filter((source) => source.text.length < 20)) {
    gaps.push(`${source.title}：没有可引用摘要，${source.retrieval?.reason ?? "也未取得可解析的正文"}；未加入证据库。`)
  }
  for (const source of admitted.filter((source) => source.kind === "abstract" || source.kind === "partial")) {
    gaps.push(
      `${source.id}（${source.title}）：${source.kind === "partial" ? "仅取得部分正文" : "目前只有摘要"}。${source.retrieval?.reason ?? ""}不能据此声称已完成全文审查；精确工艺参数必须有实际原文支持。`,
    )
  }
  signal.throwIfAborted()
  return { sources: admitted, gaps: [...new Set(gaps)] }
}
