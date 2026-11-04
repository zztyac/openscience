import { useLanguage } from "@/context/language"
import { Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { ArtifactThumb, type ThumbProps } from "./ArtifactThumb"
import { bytes } from "./bytes"
import { ago } from "./ago"
import { artifactLabel, materialArtifact } from "./artifact-entries"
import { extension } from "./artifact-thumb"
import {
  IconActivity,
  IconBookOpen,
  IconBraces,
  IconDownload,
  IconEdit,
  IconExpand,
  IconFile,
  IconFlask,
  IconFolderTree,
  IconMoreH,
  IconSparkles,
  IconTrash,
} from "@/atlas/shared/Icon"

export interface CardProps extends ThumbProps {
  companion?: StoredArtifact
  layout: "grid" | "list"
  sizes: boolean
  onOpen: (artifact: StoredArtifact) => void
  onDownload: (artifact: StoredArtifact) => void
  onRename: (artifact: StoredArtifact) => void
  onTrash: (artifact: StoredArtifact) => void
}

export function ArtifactCard(props: CardProps): JSX.Element {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const material = createMemo(() => materialArtifact(props.artifact))
  const label = createMemo(() => artifactLabel(props.artifact))
  const format = () => extension(props.artifact.current.filename).toUpperCase()
  const description = () =>
    format() === "JSON"
      ? language.t("atlas.results.structuredData")
      : format() === "MD" || format() === "MARKDOWN"
        ? language.t("atlas.results.report")
        : language.t("atlas.results.file")
  const glyph = () => {
    if (format() === "JSON") return <IconBraces size={18} />
    if (material()?.stage === "protocol") return <IconFlask size={18} />
    if (material()?.stage === "ideas") return <IconSparkles size={18} />
    if (material()?.stage === "literature") return <IconBookOpen size={18} />
    if (material()?.stage === "strategies") return <IconFolderTree size={18} />
    if (material()?.stage === "analysis") return <IconActivity size={18} />
    return <IconFile size={18} />
  }
  let trigger: HTMLButtonElement | undefined

  // The menu is wider than a grid cell, so anchoring it inside the card puts it
  // off one edge or the other -- measured at -16px, and .files-pane clips with
  // overflow: hidden, so the first column's menu was cut off rather than merely
  // misplaced. Fixed placement, clamped to the viewport, is independent of both
  // the column and the pane's own scroll.
  const place = (menu: HTMLDivElement) => {
    const anchor = trigger?.getBoundingClientRect()
    if (!anchor) return
    const box = menu.getBoundingClientRect()
    const gap = 6
    const left = Math.max(gap, Math.min(anchor.right - box.width, window.innerWidth - box.width - gap))
    const below = anchor.bottom + gap
    const top = below + box.height > window.innerHeight ? Math.max(gap, anchor.top - box.height - gap) : below
    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`
    menu.style.visibility = "visible"
  }

  // Fixed coordinates do not follow a scrolling ancestor, and .artifact-surface
  // scrolls, so a menu placed once was stranded away from its own card the
  // moment the grid moved under it. Capture phase, because the scroll happens on
  // that container rather than on the window.
  const follow = (menu: HTMLDivElement) => {
    onMount(() => {
      place(menu)
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      items.forEach((item, index) => (item.tabIndex = index === 0 ? 0 : -1))
      items[0]?.focus()
      const again = () => place(menu)
      window.addEventListener("scroll", again, true)
      window.addEventListener("resize", again)
      onCleanup(() => {
        window.removeEventListener("scroll", again, true)
        window.removeEventListener("resize", again)
      })
    })
  }

  const version = () =>
    props.artifact.versionCount > 1
      ? language.t("atlas.results.versionOf", {
          version: props.artifact.current.version,
          count: props.artifact.versionCount,
        })
      : language.t("atlas.results.version", { version: props.artifact.current.version })

  const act = (run: (artifact: StoredArtifact) => void, artifact = props.artifact) => {
    setOpen(false)
    run(artifact)
  }

  return (
    <div
      class="artifact-card"
      data-layout={props.layout}
      data-stage={material()?.stage}
      data-capture-quality={props.artifact.current.captureQuality}
    >
      {/* The actions trigger is a sibling of the open control, never nested
          inside it: a control within a control is invalid, and its label folds
          into the outer control's accessible name. 53331773 and f25d7f10 each
          fixed that same defect elsewhere in this pane. */}
      <button
        type="button"
        class="artifact-card__open"
        data-card-open
        aria-label={language.t("atlas.results.openNamed", {
          name: props.artifact.title,
          version: version().toLowerCase(),
        })}
        onClick={() => props.onOpen(props.artifact)}
      >
        <span class="artifact-card__heading" aria-hidden="true">
          <span class="artifact-card__glyph">{glyph()}</span>
          <span class="artifact-card__type">{description()}</span>
          <span class="artifact-card__format">{format()}</span>
        </span>
        <span class="artifact-card__label">
          <span class="artifact-card__name" title={props.artifact.title}>
            {label().title}
          </span>
          <Show when={label().topic}>
            {(topic) => (
              <span class="artifact-card__topic" title={topic()}>
                {topic()}
              </span>
            )}
          </Show>
        </span>
        <ArtifactThumb artifact={props.artifact} read={props.read} highlight={props.highlight} />
      </button>
      <div class="artifact-card__footer">
        <span class="artifact-card__sub" data-card-meta>
          <span data-card-saved title={new Date(props.artifact.current.createdAt).toLocaleString()}>
            {language.t("atlas.results.savedAt", { time: ago(props.artifact.current.createdAt, language.locale()) })}
          </span>
          <span class="artifact-card__meta-separator" aria-hidden="true">
            ·
          </span>
          <span class="artifact-card__version" data-card-version>
            {version()}
          </span>
          <Show when={props.sizes}>
            <span class="artifact-card__meta-separator" aria-hidden="true">
              ·
            </span>
            <span data-card-size>{bytes(props.artifact.current.size)}</span>
          </Show>
        </span>
        <Show when={props.companion}>
          {(companion) => (
            <button
              type="button"
              class="artifact-card__data"
              data-card-companion
              title={`${companion().title} · ${language.t("atlas.results.version", { version: companion().current.version })}`}
              aria-label={language.t("atlas.results.openData", { name: companion().title })}
              onClick={() => props.onOpen(companion())}
            >
              <IconBraces size={12} />
              {language.t("atlas.results.data")}
            </button>
          )}
        </Show>
      </div>

      <button
        type="button"
        ref={trigger}
        class="artifact-card__actions"
        data-card-menu
        aria-label={language.t("atlas.results.actions", { name: props.artifact.title })}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <IconMoreH size={16} strokeWidth={1.5} />
      </button>

      <Show when={open()}>
        <button
          type="button"
          class="artifact-menu__scrim"
          aria-label={language.t("atlas.results.dismissActions", { name: props.artifact.title })}
          onClick={() => setOpen(false)}
        />
        <div
          class="artifact-menu"
          role="menu"
          ref={follow}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              event.stopPropagation()
              if (event.key === "Escape") event.preventDefault()
              setOpen(false)
              trigger?.focus()
              return
            }
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
            const current = items.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              event.key === "Home"
                ? items[0]
                : event.key === "End"
                  ? items.at(-1)
                  : event.key === "ArrowDown"
                    ? items[(current + 1 + items.length) % items.length]
                    : event.key === "ArrowUp"
                      ? items[(current - 1 + items.length) % items.length]
                      : undefined
            if (!next) return
            event.preventDefault()
            items.forEach((item) => (item.tabIndex = item === next ? 0 : -1))
            next.focus()
          }}
        >
          <Show when={props.companion}>
            <span class="artifact-menu__section" role="presentation">
              {language.t("atlas.results.report")}
            </span>
          </Show>
          <button type="button" role="menuitem" data-action="open" onClick={() => act(props.onOpen)}>
            <IconExpand size={14} strokeWidth={1.5} />
            {language.t("atlas.results.open")}
          </button>
          <button type="button" role="menuitem" data-action="download" onClick={() => act(props.onDownload)}>
            <IconDownload size={14} strokeWidth={1.5} />
            {language.t("atlas.files.download")}
          </button>
          <button type="button" role="menuitem" data-action="rename" onClick={() => act(props.onRename)}>
            <IconEdit size={14} strokeWidth={1.5} />
            {language.t("atlas.results.rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-action="trash"
            class="artifact-menu__danger"
            onClick={() => act(props.onTrash)}
          >
            <IconTrash size={14} strokeWidth={1.5} />
            {language.t("atlas.results.trash")}
          </button>
          <Show when={props.companion}>
            {(companion) => (
              <>
                <span class="artifact-menu__separator" role="separator" />
                <span class="artifact-menu__section" role="presentation">
                  {language.t("atlas.results.structuredData")} · JSON
                </span>
                <button
                  type="button"
                  role="menuitem"
                  data-action="open-data"
                  onClick={() => act(props.onOpen, companion())}
                >
                  <IconBraces size={14} />
                  {language.t("atlas.results.open")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-action="download-data"
                  onClick={() => act(props.onDownload, companion())}
                >
                  <IconDownload size={14} />
                  {language.t("atlas.files.download")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-action="rename-data"
                  onClick={() => act(props.onRename, companion())}
                >
                  <IconEdit size={14} />
                  {language.t("atlas.results.rename")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-action="trash-data"
                  class="artifact-menu__danger"
                  onClick={() => act(props.onTrash, companion())}
                >
                  <IconTrash size={14} />
                  {language.t("atlas.results.trash")}
                </button>
              </>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
