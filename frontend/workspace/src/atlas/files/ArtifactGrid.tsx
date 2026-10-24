import { useLanguage } from "@/context/language"
import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { ArtifactCard } from "./ArtifactCard"
import type { ThumbProps } from "./ArtifactThumb"
import { groupBySession, sortArtifacts, type Group } from "./artifact-groups"
import { readView, writeView, type View } from "./artifact-view"
import { age } from "./ago"
import { IconChevronDown } from "@/atlas/shared/Icon"
import "./file-items.css"

export interface GridProps extends Omit<ThumbProps, "artifact"> {
  artifacts: StoredArtifact[]
  titles: Map<string, string>
  currentSession: string | undefined
  /** Set while the pane's search box is filtering, so an empty grid can say why. */
  filtered?: boolean
  /** Empty data during loading or a failed request is not a true empty state. */
  loading?: boolean
  unavailable?: boolean
  onOpen: (artifact: StoredArtifact) => void
  onDownload: (artifact: StoredArtifact) => void
  onRename: (artifact: StoredArtifact) => void
  onTrash: (artifact: StoredArtifact) => void
}

export function ArtifactGrid(props: GridProps): JSX.Element {
  const language = useLanguage()
  const [view, setView] = createSignal<View>(readView())
  const [prefs, setPrefs] = createSignal(false)
  const refs: { trigger?: HTMLButtonElement; menu?: HTMLDivElement } = {}
  const options = () => Array.from(refs.menu?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])
  const focusOption = (option: HTMLButtonElement | undefined) => {
    if (!option) return
    options().forEach((candidate) => (candidate.tabIndex = candidate === option ? 0 : -1))
    option.focus()
  }
  const openPrefs = () => {
    setPrefs(true)
    queueMicrotask(() => focusOption(options()[0]))
  }
  const closePrefs = (restoreFocus = false) => {
    setPrefs(false)
    if (restoreFocus) queueMicrotask(() => refs.trigger?.focus())
  }

  // Spread rather than mutate: readView() hands back the shared DEFAULT_VIEW
  // object itself whenever storage is empty or invalid, and writing through it
  // would rewrite the default for every later reader in the process.
  const apply = (next: Partial<View>) => {
    const merged = { ...view(), ...next }
    setView(merged)
    writeView(merged)
  }

  // Each field gets its own memo. Reading view().sort inside the grouping memo
  // subscribed it to the whole object, and apply() always writes a fresh one, so
  // toggling layout or file sizes rebuilt every Group -- which made <For>
  // recreate every card and re-read every artifact's bytes.
  const sort = createMemo(() => view().sort)
  const layout = createMemo(() => view().layout)
  const sizes = createMemo(() => view().sizes)

  // One group with no label is how the flat A-Z case reuses the grouped render
  // path; the header is what disappears, not the list.
  const groups = createMemo((): Group[] =>
    sort() === "created"
      ? groupBySession(props.artifacts, props.titles, props.currentSession)
      : [{ key: "all", label: "", artifacts: sortArtifacts(props.artifacts, "name"), newest: 0 }],
  )

  const card = (artifact: StoredArtifact) => (
    <ArtifactCard
      artifact={artifact}
      layout={layout()}
      sizes={sizes()}
      read={props.read}
      highlight={props.highlight}
      onOpen={props.onOpen}
      onDownload={props.onDownload}
      onRename={props.onRename}
      onTrash={props.onTrash}
    />
  )

  return (
    <div class="artifact-surface">
      <div class="artifact-toolbar">
        <span class="artifact-toolbar__primary">
          <span class="artifact-toolbar__count" data-artifact-count>
            {props.artifacts.length === 1
              ? language.t("atlas.results.oneCount")
              : language.t("atlas.results.count", { count: props.artifacts.length })}
          </span>
          <span class="artifact-toolbar__hint">{language.t("atlas.results.immutable")}</span>
        </span>

        {/* Sorting, layout and the optional size column are one mental model:
            how this catalog is presented. Keeping them behind one familiar
            text control leaves a 320px pane usable without deleting choices. */}
        <span class="artifact-toolbar__controls">
          <button
            ref={(element) => {
              refs.trigger = element
            }}
            type="button"
            class="artifact-toolbar__prefs"
            data-artifact-prefs
            aria-label={language.t("atlas.results.options")}
            aria-expanded={prefs()}
            onClick={() => (prefs() ? closePrefs() : openPrefs())}
          >
            {language.t("atlas.results.view")}
            <IconChevronDown size={12} strokeWidth={1.5} />
          </button>

          <Show when={prefs()}>
            <button
              type="button"
              class="artifact-menu__scrim"
              aria-label={language.t("atlas.results.dismissOptions")}
              onClick={() => closePrefs(true)}
            />
            {/* The backend does not expose the artifact-store path, so this menu
                contains presentation choices only. No guessed location or
                unsupported storage mode is presented as fact. */}
            <div
              ref={(element) => {
                refs.menu = element
              }}
              class="artifact-menu artifact-menu--prefs"
              role="menu"
              aria-label={language.t("atlas.results.options")}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Tab") {
                  event.preventDefault()
                  closePrefs(true)
                  return
                }
                const items = options()
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                const target =
                  event.key === "Home"
                    ? items[0]
                    : event.key === "End"
                      ? items.at(-1)
                      : event.key === "ArrowDown"
                        ? items[(current + 1 + items.length) % items.length]
                        : event.key === "ArrowUp"
                          ? items[(current - 1 + items.length) % items.length]
                          : undefined
                if (!target) return
                event.preventDefault()
                focusOption(target)
              }}
            >
              <span class="artifact-menu__section" role="presentation">
                {language.t("atlas.results.sort")}
              </span>
              <For each={["created", "name"] as const}>
                {(option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    tabindex="-1"
                    data-artifact-sort={option}
                    aria-checked={sort() === option}
                    onClick={() => apply({ sort: option })}
                  >
                    <span aria-hidden="true" class="artifact-menu__check">
                      {sort() === option ? "✓" : ""}
                    </span>
                    {option === "created" ? language.t("atlas.results.recent") : language.t("atlas.results.nameOrder")}
                  </button>
                )}
              </For>

              <span class="artifact-menu__section" role="presentation">
                {language.t("atlas.results.layout")}
              </span>
              <For each={["grid", "list"] as const}>
                {(option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    tabindex="-1"
                    data-artifact-layout={option}
                    aria-checked={layout() === option}
                    onClick={() => apply({ layout: option })}
                  >
                    <span aria-hidden="true" class="artifact-menu__check">
                      {layout() === option ? "✓" : ""}
                    </span>
                    {option === "grid" ? language.t("atlas.results.grid") : language.t("atlas.results.list")}
                  </button>
                )}
              </For>

              <span class="artifact-menu__separator" role="separator" />
              <button
                type="button"
                role="menuitemcheckbox"
                tabindex="-1"
                aria-checked={sizes()}
                data-pref="sizes"
                onClick={() => apply({ sizes: !sizes() })}
              >
                <span aria-hidden="true" class="artifact-menu__check">
                  {sizes() ? "✓" : ""}
                </span>
                {language.t("atlas.results.sizes")}
              </button>
            </div>
          </Show>
        </span>
      </div>

      <Show
        when={props.artifacts.length > 0}
        fallback={
          <Show when={!props.loading && !props.unavailable}>
            {/* "No artifacts saved yet." is false when a search simply matched
                nothing, and the count beside it already says 0. */}
            <div class="files-empty files-empty--artifacts" data-artifact-empty>
              <strong>
                {props.filtered ? language.t("atlas.results.noMatches") : language.t("atlas.results.empty")}
              </strong>
              <span>
                {props.filtered ? language.t("atlas.files.searchHint") : language.t("atlas.results.emptyHint")}
              </span>
            </div>
          </Show>
        }
      >
        <For each={groups()}>
          {(group) => (
            <>
              <Show when={group.key === props.currentSession ? language.t("atlas.files.source.session") : group.label}>
                <div class="artifact-group" data-artifact-group>
                  <span class="artifact-group__name">
                    {group.key === props.currentSession ? language.t("atlas.files.source.session") : group.label}
                  </span>
                  <span class="artifact-group__meta">
                    {group.artifacts.length} · {age(group.newest, language.locale())}
                  </span>
                </div>
              </Show>
              <div
                class={layout() === "grid" ? "artifact-grid" : "artifact-list"}
                {...(layout() === "grid" ? { "data-artifact-grid": true } : { "data-artifact-list": true })}
              >
                <For each={group.artifacts}>{card}</For>
              </div>
            </>
          )}
        </For>
      </Show>
    </div>
  )
}
