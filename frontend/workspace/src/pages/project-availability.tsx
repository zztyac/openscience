import { useLanguage } from "@/context/language"
import type { JSX } from "solid-js"

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export type MissingProject = {
  directory?: string
}

/**
 * Project SDK calls throw the parsed API body. Only a confirmed stale-project
 * response should replace the workspace with recovery; connectivity and other
 * server errors continue through the normal project shell.
 */
export function missingProject(error: unknown): MissingProject | undefined {
  const root = record(error)
  const candidates = [root, record(root?.error), record(root?.cause), record(root?.response)].filter(
    (value): value is Record<string, unknown> => Boolean(value),
  )

  for (const value of candidates) {
    const data = record(value.data)
    if (value.name === "ProjectStaleError" && data?.reason === "missing_directory") {
      return { directory: typeof data.directory === "string" ? data.directory : undefined }
    }
    const status = value.status ?? value.statusCode
    if (status === 410) return {}
  }
}

export function ProjectUnavailable(props: {
  directory: string
  onBack: () => void
  onRemove: () => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <main class="app-not-found project-unavailable" aria-labelledby="project-unavailable-title">
      <span class="app-not-found__eyebrow">{language.t("pages.copy.folderUnavailable")}</span>
      <h1 id="project-unavailable-title">{language.t("pages.copy.projectFolderMissing")}</h1>
      <p>{language.t("pages.copy.projectFolderMissingHint")}</p>
      <code class="project-unavailable__path" title={props.directory}>
        {props.directory}
      </code>
      <div class="project-unavailable__actions">
        <button class="app-not-found__action" type="button" onClick={props.onBack}>
          {language.t("pages.copy.backProjects")}
        </button>
        <button class="app-not-found__action app-not-found__action--quiet" type="button" onClick={props.onRemove}>
          {language.t("pages.copy.removeHome")}
        </button>
      </div>
      <p class="project-unavailable__note">{language.t("pages.copy.removeHomeHint")}</p>
    </main>
  )
}
