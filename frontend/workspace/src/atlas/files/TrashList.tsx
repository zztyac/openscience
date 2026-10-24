import { useLanguage } from "@/context/language"
import { For, Show, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { IconFile, IconFolder, IconRefresh, IconTrash } from "@/atlas/shared/Icon"
import { ago } from "./ago"

/**
 * The recovery half of the artifact store. StoredArtifactView promises that a
 * deleted artifact stays "recoverable from Files for 30 days" — this is the
 * surface that makes the promise true.
 */
export function TrashList(props: {
  rows: StoredArtifact[]
  files: TrashedFile[]
  busy?: boolean
  filtered?: boolean
  loading?: boolean
  unavailable?: boolean
  onRestore: (artifact: StoredArtifact) => void
  onRestoreFile: (file: TrashedFile) => void
  onPurgeFile: (file: TrashedFile) => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <div class="files-table" data-trash-list>
      <p class="files-trash__note">{language.t("atlas.trash.description")}</p>

      <Show
        when={props.rows.length + props.files.length}
        fallback={
          <Show when={!props.loading && !props.unavailable}>
            <div class="files-empty">
              {props.filtered ? language.t("atlas.trash.noMatches") : language.t("atlas.trash.empty")}
            </div>
          </Show>
        }
      >
        <Show when={props.files.length}>
          <div class="files-trash__section">{language.t("atlas.trash.files")}</div>
          <For each={props.files}>
            {(file) => (
              <div class="files-row files-row--trash" data-file-trash-row={file.id}>
                <span class="files-row__glyph" aria-hidden="true">
                  {file.kind === "directory" ? (
                    <IconFolder size={16} strokeWidth={1.5} />
                  ) : (
                    <IconFile size={16} strokeWidth={1.5} />
                  )}
                </span>
                <span class="files-row__name files-row__identity">
                  <span data-file-trash-name>{file.filename}</span>
                  <span class="files-row__meta">
                    {file.kind === "directory" ? language.t("atlas.trash.folder") : language.t("atlas.trash.file")} ·{" "}
                    {language.t("atlas.trash.deletedAt", { time: ago(file.trashedAt, language.locale()) })}
                  </span>
                </span>
                <span class="files-trash__actions">
                  <button
                    type="button"
                    class="files-restore"
                    data-file-trash-restore={file.id}
                    aria-label={language.t("atlas.trash.restoreNamed", { name: file.filename })}
                    disabled={props.busy}
                    onClick={() => props.onRestoreFile(file)}
                  >
                    <IconRefresh size={12} strokeWidth={1.5} />
                    {language.t("atlas.trash.restore")}
                  </button>
                  <button
                    type="button"
                    class="files-purge"
                    data-file-trash-purge={file.id}
                    aria-label={language.t("atlas.trash.purgeNamed", { name: file.filename })}
                    title={language.t("atlas.files.deletePermanently")}
                    disabled={props.busy}
                    onClick={() => props.onPurgeFile(file)}
                  >
                    <IconTrash size={12} strokeWidth={1.5} />
                  </button>
                </span>
              </div>
            )}
          </For>
        </Show>

        <Show when={props.rows.length}>
          <div class="files-trash__section">{language.t("atlas.trash.results")}</div>
          <For each={props.rows}>
            {(artifact) => (
              <div class="files-row files-row--trash" data-trash-row={artifact.id}>
                <span class="files-row__glyph" aria-hidden="true">
                  <IconFile size={16} strokeWidth={1.5} />
                </span>
                <span class="files-row__name files-row__identity">
                  <span data-trash-name>{artifact.title}</span>
                  <span class="files-row__meta" data-trash-meta>
                    {artifact.versionCount === 1
                      ? language.t("atlas.results.oneVersion")
                      : language.t("atlas.results.versionCount", { count: artifact.versionCount })}
                    <Show when={artifact.trashedAt ?? artifact.updatedAt}>
                      {(deleted) => (
                        <> · {language.t("atlas.trash.deletedAt", { time: ago(deleted(), language.locale()) })}</>
                      )}
                    </Show>
                  </span>
                </span>
                <button
                  type="button"
                  class="files-restore"
                  data-trash-restore={artifact.id}
                  aria-label={language.t("atlas.trash.restoreNamed", { name: artifact.title })}
                  disabled={props.busy}
                  onClick={() => props.onRestore(artifact)}
                >
                  <IconRefresh size={12} strokeWidth={1.5} />
                  {language.t("atlas.trash.restore")}
                </button>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}

export interface TrashedFile {
  id: string
  filename: string
  originalPath: string
  kind: "file" | "directory"
  trashedAt: number
  expiresAt: number
}
