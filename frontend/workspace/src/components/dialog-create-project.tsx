import { useLanguage } from "@/context/language"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { Dialog } from "@synsci/ui/dialog"
import { IconFolder, IconFolderAdd, IconPlus, IconX } from "@/atlas/shared/Icon"
import { For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import "./dialog-create-project.css"

export interface ProjectCreateInput {
  name: string
  sources: Array<{ path: string; access: "write" }>
}

export function DialogCreateProject(props: {
  name?: string
  sources?: string[]
  /** The platform whose native folder dialog will open; leave unset when the in-app picker is used. */
  os?: "macos" | "windows"
  onDraft?: (name: string) => void
  onChooseSources: () => void
  onRemoveSource?: (path: string) => void
  onCreate: (input: ProjectCreateInput) => Promise<void>
}): JSX.Element {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({
    name: props.name ?? "",
    busy: false,
    error: "",
  })

  // A native folder dialog belongs to one file manager; without one the in-app picker opens, which is neither.
  const hint = () => {
    if (props.os === "macos") return language.t("interface.project.finder")
    if (props.os === "windows") return language.t("interface.project.explorer")
    return language.t("interface.project.chooseFolder")
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.busy) return
    const name = state.name.trim()
    if (!name) {
      setState("error", language.t("interface.project.nameRequired"))
      return
    }

    setState({ busy: true, error: "" })
    await props
      .onCreate({
        name,
        sources: (props.sources ?? []).map((path) => ({ path, access: "write" })),
      })
      .then(
        () => dialog.close(),
        (error) => setState("error", error instanceof Error ? error.message : String(error)),
      )
    setState("busy", false)
  }

  return (
    <Dialog
      title={language.t("interface.project.create")}
      description={language.t("interface.project.description")}
      class="project-create-dialog"
      fit
      transition
    >
      <form class="project-create" onSubmit={submit}>
        <div class="project-create__body">
          <label class="project-create__field">
            <span class="project-create__label">{language.t("interface.project.name")}</span>
            <span data-focus-frame class="project-create__input-frame">
              <span class="project-create__input-icon" aria-hidden="true">
                <IconFolder size={16} strokeWidth={1.5} />
              </span>
              <input
                autofocus
                required
                name="name"
                value={state.name}
                disabled={state.busy}
                maxlength={100}
                autocomplete="off"
                placeholder={language.t("interface.project.name")}
                aria-invalid={state.error ? "true" : undefined}
                aria-describedby={state.error ? "project-create-error" : undefined}
                class="project-create__input"
                onInput={(event) => {
                  const name = event.currentTarget.value
                  setState({ name, error: "" })
                  props.onDraft?.(name)
                }}
              />
            </span>
          </label>

          <section class="project-create__sources" aria-labelledby="source-folders-heading">
            <div class="project-create__section-heading">
              <h2 id="source-folders-heading">{language.t("interface.project.sources")}</h2>
              <p>{language.t("interface.project.sourcesDescription")}</p>
            </div>

            <Show
              when={(props.sources ?? []).length > 0}
              fallback={
                <button
                  type="button"
                  class="project-create__source-empty"
                  disabled={state.busy}
                  onClick={props.onChooseSources}
                >
                  <span class="project-create__source-icon" aria-hidden="true">
                    <IconFolderAdd size={16} strokeWidth={1.5} />
                  </span>
                  <span class="project-create__source-empty-copy">
                    <strong>{language.t("interface.project.addSources")}</strong>
                    <span>{hint()}</span>
                  </span>
                </button>
              }
            >
              <div class="project-create__source-list">
                <For each={props.sources ?? []}>
                  {(path) => (
                    <div class="project-create__source-row">
                      <span class="project-create__source-row-icon" aria-hidden="true">
                        <IconFolder size={16} strokeWidth={1.5} />
                      </span>
                      <span class="project-create__source-copy">
                        <strong>{path.split("/").filter(Boolean).at(-1) ?? path}</strong>
                        <span title={path}>{path}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={language.t("interface.project.removeNamed", { path })}
                        title={language.t("interface.project.removeSource")}
                        class="project-create__remove-source"
                        onClick={() => props.onRemoveSource?.(path)}
                      >
                        <IconX size={14} strokeWidth={1.5} />
                      </button>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="project-create__add-more"
                  disabled={state.busy || (props.sources ?? []).length >= 10}
                  onClick={props.onChooseSources}
                >
                  <IconPlus size={12} strokeWidth={1.5} />
                  {language.t("interface.project.addFolders")}
                </button>
              </div>
            </Show>

            <Show when={state.error}>
              <p id="project-create-error" role="alert" class="project-create__error">
                {state.error}
              </p>
            </Show>
          </section>
        </div>

        <div class="project-create__footer">
          <Button type="button" size="large" variant="ghost" disabled={state.busy} onClick={() => dialog.close()}>
            {language.t("interface.common.cancel")}
          </Button>
          <Button type="submit" size="large" variant="primary" disabled={state.busy || !state.name.trim()}>
            {state.busy ? language.t("interface.project.creating") : language.t("interface.project.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
