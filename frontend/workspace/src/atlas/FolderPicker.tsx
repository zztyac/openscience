import { useLanguage } from "@/context/language"
import { createSignal, createMemo, createResource, createEffect, onCleanup, type JSX, For, Show } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { Button } from "@synsci/ui/button"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { validateDirectoryPath } from "@/atlas/openDirectory"
import {
  basenameLocalPath,
  displayLocalPath,
  isLocalPathRoot,
  joinLocalPath,
  localPathBreadcrumbs,
  localPathPlatform,
  localPathRoot,
  normalizeLocalPath,
  parentLocalPath,
  resolveTypedLocalPath,
} from "@/utils/local-path"
import "./FolderPicker.css"

interface FolderEntry {
  name: string
  absolute: string
  type: "file" | "directory"
}

interface PickerProps {
  multiple?: boolean
  kind?: "folder" | "file"
  title?: string
  onSelect: (result: string | string[] | null) => void
}

const RECENT_KEY = "thesis-folder-picker-recents-v1"

export function createRequestGeneration() {
  let current = 0
  onCleanup(() => void ++current)
  return {
    next: () => ++current,
    invalidate: () => void ++current,
    isCurrent: (generation: number) => generation === current,
  }
}

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr
          .filter((path: unknown): path is string => typeof path === "string")
          .map(normalizeLocalPath)
          .slice(0, 8)
      : []
  } catch {
    return []
  }
}

function pushRecent(path: string) {
  try {
    const cur = readRecents()
    const next = [path, ...cur.filter((p) => p !== path)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {}
}

/**
 * Finder/Explorer-style folder picker:
 *   - left sidebar with quick-link shortcuts (Home, Desktop, Documents,
 *     Downloads, Applications) plus recents
 *   - main pane with breadcrumbs + folder list
 *   - single click drills in, "open this folder" picks the cwd
 *
 * Backed by openscience's /file endpoint, which walks the real filesystem
 * and returns absolute paths.
 */
export function FolderPicker(props: PickerProps): JSX.Element {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const dialog = useDialog()

  const home = () => normalizeLocalPath(sync.data.path.home || "/")
  const [cwd, setCwd] = createSignal(home())
  const [filter, setFilter] = createSignal("")
  const [pathInput, setPathInput] = createSignal("")
  const [error, setError] = createSignal<string>()
  const listings = createRequestGeneration()
  const navigation = createRequestGeneration()
  let latestEntries: FolderEntry[] = []

  const [entries, { refetch }] = createResource(
    () => cwd(),
    async (dir): Promise<FolderEntry[]> => {
      const generation = listings.next()
      setError(undefined)
      try {
        const res = await sdk.client.file.list({ directory: dir, path: "." })
        if (!listings.isCurrent(generation)) return latestEntries
        const list = res.data ?? []
        latestEntries = list
          .filter(
            (n) =>
              (n.type === "directory" || (props.kind === "file" && n.type === "file")) &&
              !n.name.startsWith(".") &&
              !n.ignored,
          )
          .map((n) => ({
            name: n.name,
            absolute: normalizeLocalPath(n.absolute),
            type: n.type,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        return latestEntries
      } catch (err) {
        if (!listings.isCurrent(generation)) return latestEntries
        // Surface the failure instead of masking it as an empty folder — an
        // empty list and a failed listing are very different states.
        setError(err instanceof Error ? err.message : String(err))
        return []
      }
    },
  )

  // Use `entries.latest` so we keep the previously-rendered rows visible
  // while a new directory is being fetched. Without this the list briefly
  // empties on every navigation, which read as a "whole page refresh".
  const filtered = createMemo(() => {
    const q = filter().toLowerCase().trim()
    const list = entries.latest ?? entries() ?? []
    if (!q) return list
    return list.filter((e) => e.name.toLowerCase().includes(q))
  })

  const crumbs = createMemo(() => localPathBreadcrumbs(cwd(), home()))

  const navigate = (path: string) => {
    navigation.invalidate()
    listings.invalidate()
    setCwd(normalizeLocalPath(path))
    setFilter("")
  }

  const refresh = () => {
    listings.invalidate()
    void refetch()
  }

  const goUp = () => {
    const cur = cwd()
    if (isLocalPathRoot(cur)) return
    navigate(parentLocalPath(cur))
  }

  const drillInto = (e: FolderEntry) => {
    if (e.type === "file") {
      pick(e.absolute)
      return
    }
    navigate(e.absolute)
  }

  const goTo = (path: string) => navigate(path)

  /** Resolve `~` / relative segments and jump there. */
  const normalizeTyped = (raw: string) => resolveTypedLocalPath(raw, cwd(), home())

  /** Resolve `~` / relative segments, verify it exists, and jump there. */
  const goToTyped = async (raw: string) => {
    const abs = normalizeTyped(raw)
    if (!abs) return
    const generation = navigation.next()
    const valid = await validateDirectoryPath(sdk.url, abs)
    if (!valid || !navigation.isCurrent(generation)) return
    navigate(valid)
    setPathInput("")
  }

  const pick = (path: string) => {
    const recent = props.kind === "file" ? parentLocalPath(path) : normalizeLocalPath(path)
    pushRecent(recent)
    props.onSelect(props.multiple ? [path] : path)
    dialog.close()
  }

  const pickCurrent = async () => {
    const generation = navigation.next()
    const valid = await validateDirectoryPath(sdk.url, cwd())
    if (valid && navigation.isCurrent(generation)) pick(valid)
  }

  const cancel = () => {
    props.onSelect(null)
    dialog.close()
  }

  const sidebarLinks = createMemo(() => {
    const h = home()
    const links: Array<{ label: string; path: string; icon: IconProps["name"] }> = [
      { label: language.t("pages.overlay.home"), path: h, icon: "home" },
      { label: language.t("settings.section.desktop"), path: joinLocalPath(h, "Desktop"), icon: "layout-grid" },
      { label: language.t("pages.overlay.documents"), path: joinLocalPath(h, "Documents"), icon: "file" },
      { label: language.t("pages.overlay.downloads"), path: joinLocalPath(h, "Downloads"), icon: "download" },
    ]
    if (localPathPlatform(h) === "macos")
      links.push({ label: language.t("pages.overlay.applications"), path: "/Applications", icon: "folder-tree" })
    return links
  })

  const recents = createMemo(() => readRecents())

  return (
    <Dialog
      title={
        props.title ??
        (props.kind === "file" ? language.t("pages.overlay.chooseFile") : language.t("interface.project.chooseFolder"))
      }
      size="large"
      class="folder-picker-dialog"
      transition
    >
      <div class="folder-picker">
        <aside class="folder-picker__sidebar" aria-label={language.t("pages.overlay.folderLocations")}>
          <div class="folder-picker__sidebar-group">
            <SectionLabel>{language.t("pages.overlay.favorites")}</SectionLabel>
            <div class="folder-picker__sidebar-list">
              <For each={sidebarLinks()}>
                {(location) => (
                  <SidebarRow
                    label={location.label}
                    icon={location.icon}
                    active={cwd() === location.path}
                    onClick={() => goTo(location.path)}
                  />
                )}
              </For>
            </div>
          </div>
          <Show when={recents().length > 0}>
            <div class="folder-picker__sidebar-group">
              <SectionLabel>{language.t("interface.composer.recent")}</SectionLabel>
              <div class="folder-picker__sidebar-list">
                <For each={recents()}>
                  {(path) => (
                    <SidebarRow
                      label={basenameLocalPath(path)}
                      sublabel={displayLocalPath(path, home())}
                      icon="folder"
                      active={cwd() === path}
                      onClick={() => goTo(path)}
                      onDblClick={() => (props.kind === "file" ? goTo(path) : pick(path))}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>
        </aside>

        <section class="folder-picker__main" aria-label={language.t("pages.overlay.folderBrowser")}>
          <nav class="folder-picker__location" aria-label={language.t("atlas.files.currentFolder")}>
            <div class="folder-picker__navigation">
              <button
                type="button"
                class="folder-picker__icon-button"
                onClick={goUp}
                aria-label={language.t("atlas.files.parent")}
                title={language.t("atlas.files.parent")}
                disabled={isLocalPathRoot(cwd())}
              >
                <Icon name="arrow-up" size="small" />
              </button>
              <button
                type="button"
                class="folder-picker__icon-button"
                onClick={() => goTo(home())}
                aria-label={language.t("pages.overlay.homeFolder")}
                title={language.t("pages.overlay.homeFolder")}
              >
                <Icon name="home" size="small" />
              </button>
            </div>
            <span class="folder-picker__location-divider" aria-hidden="true" />
            <div class="folder-picker__breadcrumbs">
              <For each={crumbs()}>
                {(crumb, index) => (
                  <>
                    <Show when={index() > 0}>
                      <span class="folder-picker__breadcrumb-separator" aria-hidden="true">
                        <Icon name="chevron-right" size="small" />
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="folder-picker__breadcrumb"
                      data-current={index() === crumbs().length - 1 ? "true" : undefined}
                      aria-current={index() === crumbs().length - 1 ? "location" : undefined}
                      onClick={() => goTo(crumb.path)}
                      title={crumb.path}
                    >
                      {crumb.label}
                    </button>
                  </>
                )}
              </For>
            </div>
            <button
              type="button"
              class="folder-picker__icon-button folder-picker__refresh"
              onClick={refresh}
              aria-label={language.t("pages.overlay.refreshFolder")}
              title={language.t("pages.overlay.refreshFolder")}
            >
              <Icon name="refresh" size="small" />
            </button>
          </nav>

          <div class="folder-picker__tools">
            <label class="folder-picker__field folder-picker__search">
              <Icon name="magnifying-glass" size="small" />
              <span class="folder-picker__visually-hidden">{language.t("atlas.files.filter")}</span>
              <input
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                placeholder={
                  props.kind === "file"
                    ? language.t("pages.overlay.filterFilesFolders")
                    : language.t("pages.overlay.filterFolders")
                }
                autofocus
                autocomplete="off"
              />
              <span class="folder-picker__count tab-fig" aria-live="polite">
                {language.t(filtered().length === 1 ? "pages.overlay.itemCount.one" : "pages.overlay.itemCount.other", {
                  count: filtered().length,
                })}
              </span>
            </label>

            {/* Keep the path field always available. macOS can hide Desktop,
                Documents, and Downloads from directory listings even when an
                explicitly entered path remains valid and usable. */}
            <form
              class="folder-picker__field folder-picker__path-field"
              onSubmit={(event) => {
                event.preventDefault()
                void goToTyped(pathInput())
              }}
            >
              <Icon name="folder-tree" size="small" />
              <span class="folder-picker__field-label">{language.t("pages.overlay.path")}</span>
              <input
                value={pathInput()}
                onInput={(e) => {
                  navigation.invalidate()
                  setPathInput(e.currentTarget.value)
                }}
                aria-label={language.t("pages.overlay.goPath")}
                placeholder={
                  localPathRoot(home()) === "/" ? language.t("pages.overlay.pathExample") : "C:\\Users\\you\\research"
                }
                spellcheck={false}
                autocomplete="off"
              />
              <button type="submit" class="folder-picker__go" disabled={!pathInput().trim()}>
                {language.t("pages.overlay.go")}
              </button>
            </form>
          </div>

          <div
            class="folder-picker__list atlas-scroll"
            classList={{ "folder-picker__list--loading": entries.loading }}
            aria-busy={entries.loading}
            ref={(el) => {
              createEffect(() => {
                cwd()
                el.scrollTop = 0
              })
            }}
          >
            <Show when={entries.loading}>
              <div
                class="folder-picker__loading"
                role="progressbar"
                aria-label={language.t("pages.overlay.loadingFolder")}
              >
                <span />
              </div>
            </Show>
            <Show
              when={filtered().length > 0}
              fallback={
                <Show when={!entries.loading}>
                  <Show
                    when={!error()}
                    fallback={
                      <div class="folder-picker__empty folder-picker__empty--error atlas-fade-in" role="alert">
                        <Icon name="alert-circle" size="normal" />
                        <strong>{language.t("pages.overlay.readFolderFailed")}</strong>
                        <p>{error()}</p>
                        <button type="button" class="folder-picker__retry" onClick={refresh}>
                          {language.t("settings.connectors.retry")}
                        </button>
                      </div>
                    }
                  >
                    <div class="folder-picker__empty atlas-fade-in">
                      <Show
                        when={(entries() ?? []).length === 0}
                        fallback={<span>{language.t("pages.overlay.filterEmpty")}</span>}
                      >
                        <Show
                          when={
                            localPathPlatform(home()) === "macos" &&
                            ["Desktop", "Documents", "Downloads"].includes(basenameLocalPath(cwd()))
                          }
                          fallback={
                            <span>
                              {props.kind === "file"
                                ? language.t("pages.overlay.folderEmptyFiles")
                                : language.t("pages.overlay.folderEmptyHint")}
                            </span>
                          }
                        >
                          <strong>
                            {language.t("pages.overlay.macListing", { folder: basenameLocalPath(cwd()) })}
                          </strong>
                          <p>{language.t("pages.overlay.macListingHint")}</p>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </Show>
              }
            >
              <For each={filtered()}>
                {(e) => (
                  <PickerRow
                    entry={e}
                    onOpen={() => drillInto(e)}
                    onPick={() => pick(e.absolute)}
                    pickingFile={props.kind === "file"}
                  />
                )}
              </For>
            </Show>
          </div>

          <footer class="folder-picker__footer">
            <span class="folder-picker__current-path" title={cwd()}>
              <Icon name="folder" size="small" />
              {displayLocalPath(cwd(), home())}
            </span>
            <div class="folder-picker__footer-actions">
              <Button type="button" size="normal" variant="ghost" onClick={cancel}>
                {language.t("common.cancel")}
              </Button>
              <Show when={props.kind !== "file"}>
                <Button
                  type="button"
                  size="normal"
                  variant="primary"
                  onClick={pickCurrent}
                  title={language.t("pages.overlay.chooseCurrentFolder")}
                >
                  {language.t("pages.overlay.useFolder")}
                  <Icon name="arrow-right" size="small" />
                </Button>
              </Show>
            </div>
          </footer>
        </section>
      </div>
    </Dialog>
  )
}

function PickerRow(props: {
  entry: FolderEntry
  onOpen: () => void
  onPick: () => void
  pickingFile: boolean
}): JSX.Element {
  const language = useLanguage()
  const folder = () => props.entry.type === "directory"
  return (
    <div class="folder-picker__row" data-kind={props.entry.type}>
      <button
        type="button"
        class="folder-picker__row-open"
        onClick={props.onOpen}
        onDblClick={() => (folder() ? props.onPick() : undefined)}
        title={
          folder()
            ? language.t("pages.overlay.openFolderPath", { path: props.entry.absolute })
            : language.t("pages.overlay.chooseFilePath", { path: props.entry.absolute })
        }
      >
        <Icon name={folder() ? "folder" : "file"} size="small" />
        <span class="folder-picker__row-name">{props.entry.name}</span>
        <Show
          when={folder()}
          fallback={<span class="folder-picker__pick-label">{language.t("pages.overlay.choose")}</span>}
        >
          <span class="folder-picker__row-chevron" aria-hidden="true">
            <Icon name="chevron-right" size="small" />
          </span>
        </Show>
      </button>
      <Show when={folder() && !props.pickingFile}>
        <button
          type="button"
          class="folder-picker__choose"
          onClick={props.onPick}
          title={language.t("pages.overlay.chooseThisFolder")}
        >
          {language.t("pages.overlay.choose")}
        </button>
      </Show>
    </div>
  )
}

function SectionLabel(props: { children: JSX.Element }): JSX.Element {
  return <span class="folder-picker__section-label">{props.children}</span>
}

function SidebarRow(props: {
  label: string
  sublabel?: string
  icon: IconProps["name"]
  active: boolean
  onClick: () => void
  onDblClick?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      class="folder-picker__sidebar-row"
      data-active={props.active ? "true" : undefined}
      onClick={props.onClick}
      onDblClick={props.onDblClick}
    >
      <Icon name={props.icon} size="small" />
      <span class="folder-picker__sidebar-copy">
        <span class="folder-picker__sidebar-label">{props.label}</span>
        <Show when={props.sublabel}>
          <span class="folder-picker__sidebar-sublabel">{props.sublabel}</span>
        </Show>
      </span>
    </button>
  )
}
