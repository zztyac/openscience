import path from "path"
import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import z from "zod"
import type { MaterialSource } from "@synsci/util/materials"
import { Global } from "@/global"
import { Literature } from "@/research/literature"
import { HttpStatusError } from "@/science/connectors/http"
import { Network } from "@/settings/network"

const MAX_BYTES = 25 * 1024 * 1024
const MAX_TEXT = 200_000
const MAX_CACHE_TEXT = 1_000_000
const MAX_LOCATIONS = 4
const CACHE_VERSION = 1
const Cache = z.object({
  version: z.literal(CACHE_VERSION),
  pages: z.array(z.string()).max(2000),
  pageCount: z.number().int().positive().max(2000),
  tool: z.enum(["pdftotext", "pymupdf", "pdf.js"]),
  url: z.string().url().optional(),
  truncated: z.boolean(),
  pdf: z.string().regex(/^[a-f0-9]{32}$/),
})
type Cached = z.infer<typeof Cache>
type Extracted = Literature.Extracted & { pageCount: number; truncated?: boolean }
export interface FulltextOptions {
  projectID: string
  signal: AbortSignal
  maxChars?: number
  cacheOnly?: boolean
  /** Candidate locations returned by a scholarly connector, never model-supplied URLs. */
  pdfURLs?: string[]
}

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

/** Direct repository PDFs have no DOI lookup to corroborate their identity. */
function matchesTitle(title: string, pages: string[]) {
  const normalize = (text: string) =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  const expected = normalize(title)
  const header = normalize(pages.slice(0, 2).join(" ").slice(0, 16_000))
  if (expected.length >= 12 && header.includes(expected)) return true
  const words = [...new Set(expected.split(" ").filter((word) => word.length > 3))]
  return words.length >= 5 && words.filter((word) => header.includes(word)).length / words.length >= 0.9
}

function publicURL(raw: string) {
  try {
    const url = new URL(raw)
    if (!["https:", "http:"].includes(url.protocol)) return undefined
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.href
  } catch {
    return undefined
  }
}

function reference(source: MaterialSource): Literature.Reference | undefined {
  const doi = Literature.normalizeDOI(source.doi) ?? Literature.normalizeDOI(source.url)
  if (doi) {
    const arxiv = doi.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1]
    return arxiv ? { kind: "arxiv", id: arxiv } : { kind: "doi", doi }
  }
  if (source.url) {
    const url = new URL(source.url)
    // Match the authority too: a path or query merely mentioning arxiv.org is not an identity.
    const arxiv = ["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname)
      ? Literature.normalizeArxiv(source.url)
      : undefined
    if (arxiv) return { kind: "arxiv", id: arxiv }
  }
  if (source.fulltextURL && !["upload", "supramas"].includes(source.origin)) {
    const location = publicURL(source.fulltextURL)
    if (location) return { kind: "url", url: location }
  }
  return undefined
}

/** Locate only this source's already downloaded PDF; callers cannot supply a file path. */
export async function cachedMaterialPDF(
  source: MaterialSource,
  options: { projectID: string; root?: string },
): Promise<string | undefined> {
  try {
    const ref = reference(source)
    if (!ref) return undefined
    const root = options.root ?? path.join(Global.Path.data, "materials", "papers")
    const project = path.join(root, hash(options.projectID))
    const directory = path.join(project, hash(`${source.id}:${JSON.stringify(ref)}`))
    for (const folder of [root, project, directory]) {
      const stat = await fs.lstat(folder)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
    }
    const resolved = await fs.realpath(directory)
    if (!resolved.startsWith((await fs.realpath(root)) + path.sep)) return undefined
    const metadata = path.join(directory, "pages.json")
    const meta = await fs.lstat(metadata)
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 8_000_000) return undefined
    const parsed = Cache.safeParse(await Bun.file(metadata).json())
    if (!parsed.success) return undefined
    const file = path.join(directory, `${parsed.data.pdf}.pdf`)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || stat.size < 5) return undefined
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-" || hash(bytes) !== parsed.data.pdf) return undefined
    return file
  } catch {
    return undefined
  }
}

export function chunkPages(sourceID: string, pages: string[], maxChars = MAX_TEXT) {
  const limit = Math.max(0, Math.min(MAX_TEXT, Math.floor(maxChars)))
  const chunks: NonNullable<MaterialSource["chunks"]> = []
  const parts: string[] = []
  let used = 0
  let truncated = false
  for (const [index, raw] of pages.entries()) {
    const page = raw.replace(/\r\n?/g, "\n").replaceAll("\0", "").trim()
    if (!page) continue
    const marker = `${parts.length ? "\n\n" : ""}[p.${index + 1}]\n`
    const remaining = limit - used - marker.length
    if (remaining <= 0) {
      truncated = true
      break
    }
    const kept = page.slice(0, remaining)
    parts.push(marker + kept)
    used += marker.length + kept.length
    for (let offset = 0; offset < kept.length; offset += 2000) {
      const text = kept.slice(offset, offset + 2000)
      chunks.push({ id: `chunk_${hash(`${sourceID}:${index + 1}:${offset}:${text}`)}`, page: index + 1, text })
    }
    if (kept.length < page.length) {
      truncated = true
      break
    }
  }
  return { text: parts.join(""), chunks, truncated }
}

function cancellable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    pending.then(
      (result) => {
        signal.removeEventListener("abort", abort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

async function extractPDF(file: string, signal: AbortSignal): Promise<Extracted | undefined> {
  const { getDocumentProxy } = await import("unpdf")
  signal.throwIfAborted()
  const document = await cancellable(
    getDocumentProxy(new Uint8Array(await Bun.file(file).arrayBuffer())).then(async (document) => {
      if (signal.aborted) {
        await document.loadingTask.destroy()
        signal.throwIfAborted()
      }
      return document
    }),
    signal,
  )
  const abort = () => {
    void document.loadingTask.destroy().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    const pageCount = document.numPages
    if (pageCount > 2000) throw new Failure("论文页数超过自动读取上限，请上传与课题相关的正文部分。")
    const tool = await Literature.extractor()
    if (tool !== "pdf.js") {
      const extracted = await Literature.extract(file, signal)
      signal.throwIfAborted()
      return extracted ? { ...extracted, pageCount } : undefined
    }
    // Reading pages one at a time permits cancellation and bounded retention;
    // unpdf's whole-document helper starts every page concurrently.
    const pages: string[] = []
    let chars = 0
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      signal.throwIfAborted()
      const page = await cancellable(document.getPage(pageNumber), signal)
      const content = await cancellable(page.getTextContent(), signal)
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim()
      const remaining = MAX_CACHE_TEXT - chars
      pages.push(text.slice(0, Math.max(0, remaining)))
      chars += text.length
      page.cleanup()
      if (chars >= MAX_CACHE_TEXT)
        return { pages, pageCount, chars, tool, truncated: pageNumber < pageCount || chars > MAX_CACHE_TEXT }
    }
    return { pages, pageCount, chars, tool }
  } finally {
    signal.removeEventListener("abort", abort)
    await document.loadingTask.destroy().catch(() => {})
  }
}

class Failure extends Error {}

function failure(error: unknown) {
  if (error instanceof Failure) return error.message
  if (error instanceof Network.PolicyError)
    return "全文地址被网络访问策略拦截，请检查设置中的来源域名白名单或上传论文。"
  if (error instanceof Network.ResponseTooLargeError) return "论文 PDF 超过 25 MB 自动下载上限，请上传论文文本。"
  if (error instanceof Network.ResolutionError) return "全文来源的 DNS 解析失败，请检查网络后重试。"
  if (error instanceof HttpStatusError) {
    if ([401, 403].includes(error.status))
      return `全文来源拒绝访问（HTTP ${error.status}），可能需要机构权限或人工下载。`
    if (error.status === 404) return "开放全文链接已失效（HTTP 404），可上传论文补充。"
    if (error.status === 429) return "全文来源访问频率受限（HTTP 429），请稍后重试。"
    if (error.status >= 500) return "全文来源服务器暂时异常，请稍后重试。"
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
    return "获取或解析全文超时，请稍后重试或上传论文。"
  return "暂时无法获取或解析开放全文，请检查网络后重试，或上传论文。"
}

async function bytes(response: Response, limit: number, signal: AbortSignal) {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10)
  if (declared > limit) {
    await response.body?.cancel().catch(() => {})
    throw new Network.ResponseTooLargeError({ limitBytes: limit, declaredBytes: declared })
  }
  if (!response.body) throw new Failure("全文来源返回了空文件，请稍后重试或上传论文。")
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await cancellable(reader.read(), signal)
      if (next.done) break
      size += next.value.length
      if (size > limit) throw new Network.ResponseTooLargeError({ limitBytes: limit, receivedBytes: size })
      parts.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  if (new TextDecoder().decode(result.subarray(0, 5)) !== "%PDF-")
    throw new Failure("全文链接返回了网页或验证页面，未取得可解析的 PDF；请上传论文补充。")
  return result
}

function sparse(cached: Cached) {
  return (
    cached.pages.length < cached.pageCount ||
    cached.pages.some((page) => page.replace(/\s/g, "").length < 100) ||
    cached.pages.reduce((sum, page) => sum + page.length, 0) < Math.max(1000, cached.pageCount * 300)
  )
}

function fromCache(source: MaterialSource, cached: Cached, maxChars: number): MaterialSource {
  const rendered = chunkPages(source.id, cached.pages, maxChars)
  const incomplete = sparse(cached)
  const clipped = cached.truncated || rendered.truncated
  const partial = clipped || incomplete
  const retrieval = {
    status: partial ? ("partial" as const) : ("fulltext" as const),
    attemptedAt: Date.now(),
    url: cached.url,
    pageCount: cached.pageCount,
    extractor: cached.tool,
    reason: clipped
      ? "正文超过本轮文本容量，已保留可追溯的部分内容，不能视为已完整阅读。"
      : incomplete
        ? "部分页面文字不足或未能提取，可能包含扫描页；尚未完成全文读取，可上传 OCR 后的论文。"
        : undefined,
  }
  if (rendered.text.length < 20 || !rendered.chunks.length)
    return {
      ...source,
      retrieval: {
        ...retrieval,
        status: "unavailable",
        reason: "PDF 未提取到足够正文，可能是扫描件；请上传 OCR 后的文本。",
      },
    }
  return { ...source, kind: partial ? "partial" : "fulltext", text: rendered.text, chunks: rendered.chunks, retrieval }
}

/** Dependencies are injectable at the network/extraction boundary; cache and evidence handling stay real in tests. */
export function createFulltextEnricher(
  deps: {
    resolve?: typeof Literature.resolve
    fetch?: typeof Network.fetch
    extract?: (file: string, signal: AbortSignal) => Promise<Extracted | undefined>
    root?: string
    maxBytes?: number
    timeoutMs?: number
  } = {},
) {
  const resolve = deps.resolve ?? Literature.resolve
  const fetch = deps.fetch ?? Network.fetch
  const extract = deps.extract ?? extractPDF
  const root = deps.root ?? path.join(Global.Path.data, "materials", "papers")
  return async function enrich(source: MaterialSource, options: FulltextOptions): Promise<MaterialSource> {
    options.signal.throwIfAborted()
    if (source.origin === "upload" || source.kind === "note" || source.kind === "fulltext") return source
    const ref = reference(source)
    if (!ref && options.cacheOnly) return source
    if (!ref)
      return {
        ...source,
        retrieval: {
          status: "unavailable",
          attemptedAt: Date.now(),
          reason: "缺少可精确定位的 DOI 或 arXiv 标识，保留摘要；可上传论文补充。",
        },
      }
    const maxChars = Math.max(0, Math.min(MAX_TEXT, Math.floor(options.maxChars ?? MAX_TEXT)))
    if (maxChars < 20 && options.cacheOnly) return source
    if (maxChars < 20)
      return {
        ...source,
        retrieval: { status: "unavailable", attemptedAt: Date.now(), reason: "本轮文献文本容量已用完，保留现有资料。" },
      }
    const dir = path.join(root, hash(options.projectID), hash(`${source.id}:${JSON.stringify(ref)}`))
    const metadata = Bun.file(path.join(dir, "pages.json"))
    const cached = metadata.size <= 8_000_000 ? await metadata.json().catch(() => undefined) : undefined
    const parsed = Cache.safeParse(cached)
    options.signal.throwIfAborted()
    const reusable =
      parsed.success && (await Bun.file(path.join(dir, `${parsed.data.pdf}.pdf`)).exists()) ? parsed.data : undefined
    options.signal.throwIfAborted()
    if (options.cacheOnly) return reusable ? fromCache(source, reusable, maxChars) : source
    if (reusable && (!sparse(reusable) || reusable.truncated)) return fromCache(source, reusable, maxChars)
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(deps.timeoutMs ?? 60_000)])
    const unavailable = (reason: string) => ({
      ...source,
      retrieval: { status: "unavailable" as const, attemptedAt: Date.now(), reason },
    })
    let last = "未找到可下载的开放全文，保留摘要；可上传机构已授权获取的论文。"
    let partial = reusable ? fromCache(source, reusable, maxChars) : undefined
    try {
      const resolved = await cancellable(resolve(ref, signal), signal).catch((error) => {
        signal.throwIfAborted()
        if (!options.pdfURLs?.length) throw error
        return { reference: ref, key: "skill-location", pdf: undefined, pdfs: [] as string[] }
      })
      signal.throwIfAborted()
      const locations = [
        ...new Set(
          [...(options.pdfURLs ?? []), ...(resolved.pdfs ?? []), resolved.pdf].filter((url): url is string => !!url),
        ),
      ].slice(0, MAX_LOCATIONS)
      for (const location of locations) {
        signal.throwIfAborted()
        const attempt = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
        const temporary = `${dir}.${randomUUID()}.tmp`
        try {
          const response = await cancellable(
            fetch(
              location,
              {
                signal: attempt,
                headers: { accept: "application/pdf", "user-agent": "OpenScience-Materials/1.0" },
              },
              { maxResponseBytes: deps.maxBytes ?? MAX_BYTES, streamResponse: true, maxRedirects: 5 },
            ).then(async (response) => {
              if (attempt.aborted) {
                await response.body?.cancel().catch(() => {})
                attempt.throwIfAborted()
              }
              return response
            }),
            attempt,
          )
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            throw new HttpStatusError(response.status, "Fulltext request failed")
          }
          const pdf = await bytes(response, deps.maxBytes ?? MAX_BYTES, attempt)
          attempt.throwIfAborted()
          await fs.mkdir(temporary, { recursive: true, mode: 0o700 })
          const file = path.join(temporary, "paper.pdf")
          await Bun.write(file, pdf, { mode: 0o600 })
          const extracted = await cancellable(extract(file, attempt), attempt)
          attempt.throwIfAborted()
          if (!extracted || extracted.pageCount < 1) throw new Failure("PDF 未提取到正文，请上传 OCR 后的论文文本。")
          if (ref.kind === "url" && !matchesTitle(source.title, extracted.pages))
            throw new Failure("下载文件的首页未能核对论文标题，未将其加入正文证据；请核对原文。")
          let remaining = MAX_CACHE_TEXT
          const pages = extracted.pages.slice(0, 2000).map((page) => {
            const text = page.slice(0, Math.max(0, remaining))
            remaining -= text.length
            return text
          })
          const record: Cached = {
            version: CACHE_VERSION,
            pages,
            pageCount: extracted.pageCount,
            tool: extracted.tool,
            url: publicURL(Network.finalURL(response) || location),
            truncated:
              !!extracted.truncated || pages.length < extracted.pages.length || extracted.chars > MAX_CACHE_TEXT,
            pdf: hash(pdf),
          }
          const result = fromCache(source, record, maxChars)
          if (result.retrieval?.status === "unavailable") {
            last = result.retrieval.reason ?? last
            continue
          }
          if (result.kind === "partial" && partial && partial.text.length >= result.text.length) continue
          // Metadata is published last and points at immutable PDF bytes, so a
          // retry cannot observe text from one copy paired with another PDF.
          await Bun.write(path.join(temporary, "pages.json"), JSON.stringify(record), { mode: 0o600 })
          attempt.throwIfAborted()
          await fs.mkdir(dir, { recursive: true, mode: 0o700 })
          await fs.rename(file, path.join(dir, `${record.pdf}.pdf`))
          attempt.throwIfAborted()
          await fs.rename(path.join(temporary, "pages.json"), path.join(dir, "pages.json"))
          if (result.kind === "fulltext") return result
          partial = result
        } catch (error) {
          options.signal.throwIfAborted()
          last = failure(error)
        } finally {
          await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
        }
      }
      options.signal.throwIfAborted()
      return partial ?? unavailable(last)
    } catch (error) {
      options.signal.throwIfAborted()
      return partial ?? unavailable(failure(error))
    }
  }
}

export const enrichFulltext = createFulltextEnricher()
