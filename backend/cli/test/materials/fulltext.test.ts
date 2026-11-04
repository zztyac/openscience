import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { MaterialSourceInput, type MaterialSource } from "@synsci/util/materials"
import { cachedMaterialPDF, chunkPages, createFulltextEnricher } from "../../src/materials/fulltext"
import { Network } from "../../src/settings/network"

const dirs: string[] = []
const paragraph =
  "The REBCO film was deposited by pulsed laser deposition. Critical current density increased with controlled pinning defects. "
const pages = [paragraph.repeat(12), `Results and discussion. ${paragraph.repeat(12)}`]
const pdf = paperPDF(pages)
const secret = "https://publisher.example.org/article.pdf?api_key=secret-fixture"

function paperPDF(pages: string[], extra = "") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ]
  const font = 3 + pages.length * 2
  for (const [index, text] of pages.entries()) {
    const lines = text.match(/.{1,65}/g) ?? []
    const stream = `BT /F1 10 Tf 12 TL 50 740 Td ${lines.map((line, i) => `${i ? "T* " : ""}(${line.replace(/[()\\]/g, "\\$&")}) Tj`).join("\n")} ET\n${extra}`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    )
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  let body = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function source(): MaterialSource {
  return {
    id: "src-paper",
    title: "REBCO pinning study",
    authors: "A. Researcher",
    doi: "10.1000/test",
    url: "https://doi.org/10.1000/test",
    origin: "openalex",
    kind: "abstract",
    text: "We investigate critical currents in REBCO films and artificial pinning defects.",
    createdAt: 123,
  }
}

async function fixture(deps: Parameters<typeof createFulltextEnricher>[0] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "materials-fulltext-"))
  dirs.push(root)
  return {
    root,
    enrich: createFulltextEnricher({
      root,
      resolve: async (reference) => ({ reference, key: "fixture", pdf: secret }),
      fetch: async () => new Response(pdf, { headers: { "content-type": "application/pdf" } }),
      extract: async () => ({ pages, chars: pages.join("").length, pageCount: 2, tool: "pdf.js" }),
      ...deps,
    }),
  }
}

function options(extra: { maxChars?: number; signal?: AbortSignal; projectID?: string; cacheOnly?: boolean } = {}) {
  return { projectID: "mat-project", signal: new AbortController().signal, ...extra }
}

test("extracts page evidence and sanitizes public retrieval metadata", async () => {
  const { enrich } = await fixture()
  const before = source()
  const result = await enrich(before, options())
  expect(result.kind).toBe("fulltext")
  expect(result.retrieval).toMatchObject({
    status: "fulltext",
    pageCount: 2,
    extractor: "pdf.js",
    url: "https://publisher.example.org/article.pdf",
  })
  expect(result).toMatchObject({
    id: before.id,
    doi: before.doi,
    title: before.title,
    origin: before.origin,
    createdAt: before.createdAt,
  })
  expect(result.text).toContain("[p.2]")
  expect(result.chunks?.every((chunk) => result.text.includes(chunk.text) && chunk.text.length <= 2000)).toBe(true)
  expect(result.chunks?.map((chunk) => chunk.page)).toEqual([1, 2])
  expect(JSON.stringify(result)).not.toContain("secret-fixture")
})

test("connector-provided PDF locations remain usable when DOI resolution fails", async () => {
  const requested: string[] = []
  const { enrich } = await fixture({
    resolve: async () => {
      throw new Error("OpenAlex unavailable")
    },
    fetch: async (url) => {
      requested.push(String(url))
      return new Response(pdf)
    },
  })
  const result = await enrich(source(), { ...options(), pdfURLs: ["https://repository.example/original.pdf"] })
  expect(result.kind).toBe("fulltext")
  expect(requested).toEqual(["https://repository.example/original.pdf"])
})

test("a scholarly repository PDF without DOI is title-checked and archived under a stable identity", async () => {
  const { enrich, root } = await fixture({
    resolve: async (reference) => ({ reference, key: "repository", pdf: "https://repository.example/paper.pdf" }),
  })
  const paper = {
    ...source(),
    doi: undefined,
    title: "The REBCO film was deposited by pulsed laser deposition",
    origin: "exa-search" as const,
    fulltextURL: "https://repository.example/paper.pdf",
    url: "https://repository.example/record",
  }
  const result = await enrich(paper, options())
  expect(result.kind).toBe("fulltext")
  expect(await cachedMaterialPDF(result, { projectID: "mat-project", root })).toBeDefined()
  const mismatch = await enrich(
    { ...paper, id: "different-paper", title: "Completely unrelated catalysts for tropical plant growth" },
    options(),
  )
  expect(mismatch.kind).toBe("abstract")
  expect(mismatch.retrieval?.reason).toContain("核对论文标题")
})

test("a real PDF is read with bundled pdf.js, including original page count", async () => {
  const { enrich, root } = await fixture({ extract: undefined })
  const original = process.env.PATH
  process.env.PATH = root
  try {
    const result = await enrich(source(), options())
    expect(result.kind).toBe("fulltext")
    expect(result.retrieval?.extractor).toBe("pdf.js")
    expect(result.retrieval?.pageCount).toBe(2)
    expect(result.chunks?.[1].text).toContain("Results and discussion")
  } finally {
    process.env.PATH = original
  }
})

test("pdf.js preserves word boundaries between geometrically separated text runs", async () => {
  const split = paperPDF([pages[0]], "BT /F1 10 Tf 50 100 Td (critical) Tj 45 0 Td (current) Tj ET")
  const { enrich, root } = await fixture({ extract: undefined, fetch: async () => new Response(split) })
  const original = process.env.PATH
  process.env.PATH = root
  try {
    const result = await enrich(source(), options())
    expect(result.kind).toBe("fulltext")
    expect(result.retrieval?.extractor).toBe("pdf.js")
    expect(result.text).toContain("critical current")
    expect(result.text).not.toContain("criticalcurrent")
  } finally {
    process.env.PATH = original
  }
})

test("cache survives a new enricher and avoids repeated resolver and PDF calls", async () => {
  const { enrich, root } = await fixture()
  const first = await enrich(source(), options())
  const cached = createFulltextEnricher({
    root,
    resolve: async () => {
      throw new Error("must not resolve")
    },
    fetch: async () => {
      throw new Error("must not download")
    },
    extract: async () => {
      throw new Error("must not extract")
    },
  })
  const second = await cached(source(), options())
  expect(second.kind).toBe("fulltext")
  expect(second.text).toBe(first.text)
  expect(second.chunks).toEqual(first.chunks)
  const files = await fs.readdir(root, { recursive: true })
  expect(files.some((file) => file.endsWith(".pdf"))).toBe(true)
  expect(files.some((file) => file.endsWith("pages.json"))).toBe(true)
  expect(files.some((file) => file.includes(".tmp"))).toBe(false)
})

test("cached PDF lookup only exposes the exact source and project original", async () => {
  let downloads = 0
  const { enrich, root } = await fixture({
    fetch: async () => {
      downloads++
      return new Response(pdf)
    },
  })
  const original = source()
  await enrich(original, options())
  const file = await cachedMaterialPDF(original, { projectID: "mat-project", root })
  expect(file).toBeDefined()
  expect(new Uint8Array(await Bun.file(file!).arrayBuffer())).toEqual(pdf)
  expect(await cachedMaterialPDF(original, { projectID: "another-project", root })).toBeUndefined()
  expect(
    await cachedMaterialPDF({ ...original, id: "another-source" }, { projectID: "mat-project", root }),
  ).toBeUndefined()
  expect(
    await cachedMaterialPDF({ ...original, doi: "10.1000/another" }, { projectID: "mat-project", root }),
  ).toBeUndefined()
  expect(downloads).toBe(1)
})

test("cached PDF lookup rejects path metadata, replaced bytes, and file symlinks", async () => {
  const { enrich, root } = await fixture()
  await enrich(source(), options())
  const file = (await cachedMaterialPDF(source(), { projectID: "mat-project", root }))!
  const metadata = path.join(path.dirname(file), "pages.json")
  const record = await Bun.file(metadata).json()
  await Bun.write(metadata, JSON.stringify({ ...record, pdf: "../../private" }))
  expect(await cachedMaterialPDF(source(), { projectID: "mat-project", root })).toBeUndefined()
  await Bun.write(metadata, JSON.stringify(record))
  await Bun.write(file, "%PDF-1.7\nchanged")
  expect(await cachedMaterialPDF(source(), { projectID: "mat-project", root })).toBeUndefined()
  const outside = path.join(root, "private.pdf")
  await Bun.write(outside, pdf)
  await fs.unlink(file)
  await fs.symlink(outside, file)
  expect(await cachedMaterialPDF(source(), { projectID: "mat-project", root })).toBeUndefined()
})

test("cached PDF lookup rejects a symlinked project directory", async () => {
  const { enrich, root } = await fixture()
  await enrich(source(), options())
  const file = (await cachedMaterialPDF(source(), { projectID: "mat-project", root }))!
  const project = path.dirname(path.dirname(file))
  const elsewhere = path.join(root, "elsewhere")
  await fs.rename(project, elsewhere)
  await fs.symlink(elsewhere, project)
  expect(await cachedMaterialPDF(source(), { projectID: "mat-project", root })).toBeUndefined()
})

test("cache-only rehydration uses a larger text budget without any network calls", async () => {
  const { enrich, root } = await fixture()
  const clipped = await enrich(source(), options({ maxChars: 1000 }))
  expect(clipped.kind).toBe("partial")
  let calls = 0
  const cached = createFulltextEnricher({
    root,
    resolve: async () => {
      calls++
      throw new Error("must not resolve")
    },
    fetch: async () => {
      calls++
      throw new Error("must not fetch")
    },
  })
  const result = await cached(clipped, options({ cacheOnly: true, maxChars: 10000 }))
  expect(result.kind).toBe("fulltext")
  expect(result.retrieval?.status).toBe("fulltext")
  expect(result.text.length).toBeGreaterThan(clipped.text.length)
  expect(result.chunks?.every((chunk) => result.text.includes(chunk.text))).toBe(true)
  expect(calls).toBe(0)
})

test("cache-only misses preserve the original source without resolving or downloading", async () => {
  let calls = 0
  const { enrich } = await fixture({
    resolve: async () => {
      calls++
      throw new Error("must not resolve")
    },
    fetch: async () => {
      calls++
      throw new Error("must not fetch")
    },
  })
  const original = source()
  expect(await enrich(original, options({ cacheOnly: true }))).toBe(original)
  const unidentified = { ...source(), doi: undefined, url: undefined }
  expect(await enrich(unidentified, options({ cacheOnly: true }))).toBe(unidentified)
  expect(calls).toBe(0)
})

test("cache-only rehydration preserves sparse evidence without retrying network", async () => {
  const { enrich, root } = await fixture({
    extract: async () => ({ pages: [pages[0]], pageCount: 2, chars: pages[0].length, tool: "pdf.js" }),
  })
  const partial = await enrich(source(), options())
  let calls = 0
  const cached = createFulltextEnricher({
    root,
    resolve: async () => {
      calls++
      throw new Error("must not resolve")
    },
  })
  const result = await cached(partial, options({ cacheOnly: true }))
  expect(result.kind).toBe("partial")
  expect(result.text).toBe(partial.text)
  expect(calls).toBe(0)
})

test("cache keys cannot escape a project directory", async () => {
  const { enrich, root } = await fixture()
  await enrich({ ...source(), id: "../../escape" }, options({ projectID: "../../project" }))
  const projects = await fs.readdir(root)
  expect(projects).toHaveLength(1)
  expect(projects[0]).toMatch(/^[a-f0-9]{32}$/)
  expect((await fs.readdir(path.join(root, projects[0])))[0]).toMatch(/^[a-f0-9]{32}$/)
})

test("HTTP failures and HTML cannot masquerade as full text, and alternate copies are tried", async () => {
  const calls: string[] = []
  const { enrich } = await fixture({
    resolve: async (reference) => ({
      reference,
      key: "fixture",
      pdfs: ["https://one.invalid/a", "https://two.invalid/b", secret],
    }),
    fetch: async (url) => {
      calls.push(url)
      if (calls.length === 1) return new Response("Forbidden", { status: 403 })
      if (calls.length === 2)
        return new Response("<html>Please verify browser</html>", { headers: { "content-type": "application/pdf" } })
      return new Response(pdf)
    },
  })
  expect((await enrich(source(), options())).kind).toBe("fulltext")
  expect(calls).toHaveLength(3)
})

for (const [status, message] of [
  [403, "拒绝访问"],
  [404, "链接已失效"],
  [429, "频率受限"],
  [503, "暂时异常"],
] as const) {
  test(`HTTP ${status} preserves the abstract with a safe reason`, async () => {
    const { enrich } = await fixture({ fetch: async () => new Response(secret, { status }) })
    const result = await enrich(source(), options())
    expect(result.kind).toBe("abstract")
    expect(result.text).toBe(source().text)
    expect(result.retrieval?.status).toBe("unavailable")
    expect(result.retrieval?.reason).toContain(message)
    expect(JSON.stringify(result)).not.toContain("secret-fixture")
  })
}

test("landing HTML is not passed to PDF extraction", async () => {
  let extractions = 0
  const { enrich } = await fixture({
    fetch: async () => new Response("<html>Abstract only</html>"),
    extract: async () => {
      extractions++
      return undefined
    },
  })
  const result = await enrich(source(), options())
  expect(result.kind).toBe("abstract")
  expect(result.retrieval?.reason).toContain("网页或验证页面")
  expect(extractions).toBe(0)
})

test("closed papers preserve the original source and do not download", async () => {
  let downloads = 0
  const { enrich } = await fixture({
    resolve: async (reference) => ({ reference, key: "fixture", closed: "no OA copy" }),
    fetch: async () => {
      downloads++
      return new Response(pdf)
    },
  })
  const result = await enrich(source(), options())
  expect(result.kind).toBe("abstract")
  expect(result.retrieval?.reason).toContain("未找到")
  expect(downloads).toBe(0)
})

test("unknown errors never expose URLs, credentials or local paths", async () => {
  const { enrich } = await fixture({
    resolve: async () => {
      throw new Error(`${secret} /private/data/file.pdf Authorization: secret`)
    },
  })
  const result = await enrich(source(), options())
  expect(result.retrieval?.status).toBe("unavailable")
  expect(JSON.stringify(result)).not.toContain("secret")
  expect(JSON.stringify(result)).not.toContain("/private/")
})

test("network policy remains enforced, including after redirects", async () => {
  const previous = await Network.get()
  await Network.set({ ...Network.defaults(), allowlistEnabled: true })
  const connections: string[] = []
  const { enrich } = await fixture({
    resolve: async (reference) => ({ reference, key: "fixture", pdf: "https://arxiv.org/pdf/2401.00001" }),
    fetch: (url, init, policy) =>
      Network.fetch(url, init, {
        ...policy,
        resolveAddresses: async () => ["93.184.216.34"],
        transport: async (target) => {
          connections.push(target.href)
          return new Response(null, { status: 302, headers: { location: secret } })
        },
      }),
  })
  try {
    const result = await enrich(source(), options())
    expect(result.retrieval?.reason).toContain("网络访问策略")
    expect(connections).toHaveLength(1)
  } finally {
    await Network.set(previous)
  }
})

for (const [name, extracted] of [
  ["sparse body", { pages: ["Only the abstract was extracted from the PDF."], pageCount: 1 }],
  ["trailing scanned page", { pages: [pages[0]], pageCount: 2 }],
  ["internal empty page", { pages: [pages[0], "", pages[1]], pageCount: 3 }],
] as const) {
  test(`${name} is marked partial`, async () => {
    const { enrich } = await fixture({
      extract: async () => ({
        pages: [...extracted.pages],
        pageCount: extracted.pageCount,
        chars: extracted.pages.join("").length,
        tool: "pdf.js",
      }),
    })
    const result = await enrich(source(), options())
    expect(result.kind).toBe("partial")
    expect(result.retrieval?.status).toBe("partial")
    expect(result.retrieval?.reason).toContain("文字不足")
  })
}

test("a better full copy replaces a partial cache atomically", async () => {
  let extractions = 0
  const { enrich, root } = await fixture({
    resolve: async (reference) => ({ reference, key: "fixture", pdfs: ["https://one.invalid/a", secret] }),
    extract: async () =>
      ++extractions === 1
        ? { pages: [pages[0]], pageCount: 2, chars: pages[0].length, tool: "pdf.js" }
        : { pages, pageCount: 2, chars: pages.join("").length, tool: "pdf.js" },
  })
  expect((await enrich(source(), options())).kind).toBe("fulltext")
  expect((await createFulltextEnricher({ root })(source(), options())).kind).toBe("fulltext")
})

test("a partial cache is retried and upgrades when a complete copy becomes available", async () => {
  const { enrich, root } = await fixture({
    extract: async () => ({ pages: [pages[0]], pageCount: 2, chars: pages[0].length, tool: "pdf.js" }),
  })
  const partial = await enrich(source(), options())
  expect(partial.kind).toBe("partial")
  let downloads = 0
  const retry = createFulltextEnricher({
    root,
    resolve: async (reference) => ({ reference, key: "retry", pdf: secret }),
    fetch: async () => {
      downloads++
      return new Response(pdf)
    },
    extract: async () => ({ pages, pageCount: 2, chars: pages.join("").length, tool: "pdf.js" }),
  })
  expect((await retry(partial, options())).kind).toBe("fulltext")
  expect(downloads).toBe(1)
})

test("a worse partial copy cannot replace better cached evidence", async () => {
  const { enrich, root } = await fixture({
    extract: async () => ({ pages: [pages[0]], pageCount: 2, chars: pages[0].length, tool: "pdf.js" }),
  })
  const first = await enrich(source(), options())
  const worse = createFulltextEnricher({
    root,
    resolve: async (reference) => ({ reference, key: "retry", pdf: secret }),
    fetch: async () => new Response(pdf),
    extract: async () => ({
      pages: ["Only a few words of this paper could be extracted."],
      pageCount: 2,
      chars: 50,
      tool: "pdf.js",
    }),
  })
  const result = await worse(source(), options())
  expect(result.text).toBe(first.text)
  const offline = createFulltextEnricher({
    root,
    resolve: async () => {
      throw new Error("offline")
    },
  })
  expect((await offline(source(), options())).text).toBe(first.text)
})

test("text limits produce partial evidence without changing chunk provenance", async () => {
  const { enrich } = await fixture()
  const result = await enrich(source(), options({ maxChars: 2100 }))
  expect(result.kind).toBe("partial")
  expect(result.text.length).toBe(2100)
  expect(result.retrieval?.reason).toContain("文本容量")
  expect(result.chunks?.every((chunk) => result.text.includes(chunk.text))).toBe(true)
})

test("empty scanned PDFs preserve abstracts", async () => {
  const { enrich } = await fixture({ extract: async () => ({ pages: [], pageCount: 3, chars: 0, tool: "pdf.js" }) })
  const result = await enrich(source(), options())
  expect(result.kind).toBe("abstract")
  expect(result.text).toBe(source().text)
  expect(result.retrieval?.status).toBe("unavailable")
})

for (const declared of [false, true]) {
  test(`download size is bounded with ${declared ? "declared" : "streamed"} length`, async () => {
    const { enrich } = await fixture({
      maxBytes: 32,
      fetch: async () =>
        new Response(pdf, { headers: declared ? { "content-length": String(pdf.length) } : undefined }),
    })
    const result = await enrich(source(), options())
    expect(result.kind).toBe("abstract")
    expect(result.retrieval?.reason).toContain("下载上限")
  })
}

test("caller cancellation rejects even if the resolver ignores its signal", async () => {
  const controller = new AbortController()
  const reason = new Error("user cancelled")
  const { enrich } = await fixture({
    resolve: async () => {
      controller.abort(reason)
      return new Promise(() => {})
    },
  })
  await expect(enrich(source(), options({ signal: controller.signal }))).rejects.toBe(reason)
})

test("caller cancellation during body reading rejects and cancels the stream", async () => {
  const controller = new AbortController()
  const reason = new Error("user cancelled")
  let cancelled = false
  const { enrich } = await fixture({
    fetch: async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              controller.abort(reason)
            },
            cancel() {
              cancelled = true
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  })
  await expect(enrich(source(), options({ signal: controller.signal }))).rejects.toBe(reason)
  expect(cancelled).toBe(true)
})

test("timeout has a safe reason and does not hang an uncooperative resolver", async () => {
  const { enrich } = await fixture({ timeoutMs: 5, resolve: async () => new Promise(() => {}) })
  const result = await enrich(source(), options())
  expect(result.kind).toBe("abstract")
  expect(result.retrieval?.reason).toContain("超时")
})

test("identity resolution never guesses from a title or a deceptive arxiv URL", async () => {
  let calls = 0
  const { enrich } = await fixture({
    resolve: async (reference) => {
      calls++
      return { reference, key: "fixture" }
    },
  })
  const result = await enrich(
    { ...source(), doi: undefined, url: "https://evil.invalid/arxiv.org/pdf/2401.00001" },
    options(),
  )
  expect(result.retrieval?.status).toBe("unavailable")
  expect(calls).toBe(0)
})

test("arxiv identity and metadata-only search records can acquire full text", async () => {
  const { enrich } = await fixture({
    resolve: async (reference) => {
      expect(reference).toEqual({ kind: "arxiv", id: "2401.00001" })
      return { reference, key: "fixture", pdf: secret }
    },
  })
  const result = await enrich(
    { ...source(), doi: undefined, url: "https://arxiv.org/abs/2401.00001v2", text: "" },
    options(),
  )
  expect(result.kind).toBe("fulltext")
})

test("page chunks remain stable and reject server-owned upload metadata", () => {
  const first = chunkPages("source", ["a".repeat(4500), "b".repeat(1000)])
  expect(first.chunks.map((chunk) => chunk.text.length)).toEqual([2000, 2000, 500, 1000])
  expect(first.chunks).toEqual(chunkPages("source", ["a".repeat(4500), "b".repeat(1000)]).chunks)
  const { id, origin, createdAt, ...input } = source()
  expect(MaterialSourceInput.safeParse(input).success).toBe(true)
  expect(MaterialSourceInput.safeParse({ ...input, kind: "partial" }).success).toBe(false)
  expect(MaterialSourceInput.safeParse({ ...input, chunks: first.chunks }).success).toBe(false)
  expect(MaterialSourceInput.safeParse({ ...input, retrieval: { status: "fulltext", attemptedAt: 1 } }).success).toBe(
    false,
  )
})
