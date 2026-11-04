import { ensurePdfWorker } from "@/science/renderers/documents/pdfjs-worker"
import type { Translator } from "./i18n"
import { SettingsApiError } from "@/components/settings/api"
import type { MaterialRequest } from "./session-card"

export function materialRequest(transport: (path: string, init?: RequestInit) => Promise<Response>): MaterialRequest {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers)
    if (init?.body instanceof FormData) headers.delete("content-type")
    else if (init?.body) headers.set("content-type", "application/json")
    const response = await transport(path, { ...init, headers })
    const data = await response.json().catch(() => undefined)
    if (!response.ok) {
      const value = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined
      const message =
        typeof value?.message === "string"
          ? value.message
          : typeof value?.error === "string"
            ? value.error
            : `Request failed (${response.status})`
      throw new SettingsApiError(message, response.status)
    }
    if (data === undefined) throw new Error("The materials service returned an invalid response.")
    return data as T
  }
}

export async function sourceText(file: File, t: Translator): Promise<string> {
  if (file.size > 20_000_000) throw new Error(t("fileTooLarge"))
  const name = file.name.toLowerCase()
  if (!/\.(pdf|txt|md|markdown)$/.test(name)) throw new Error(t("unsupportedFile"))
  const text = await (async () => {
    if (!name.endsWith(".pdf")) return file.text()
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs")
    ensurePdfWorker(pdf.GlobalWorkerOptions)
    const task = pdf.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    const doc = await task.promise
    try {
      const pages: string[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        const text = content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join("")
          .trim()
        pages.push(`[Page ${i}]\n${text}`)
        if (pages.reduce((count, page) => count + page.length, 0) > 200_000) throw new Error(t("fileTooLarge"))
      }
      if (
        pages
          .join("")
          .replace(/\[Page \d+\]/g, "")
          .trim().length < 20
      )
        throw new Error(t("pdfEmpty"))
      return pages.join("\n\n")
    } finally {
      await task.destroy()
    }
  })()
  if (text.length > 200_000) throw new Error(t("fileTooLarge"))
  return text
}

export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
