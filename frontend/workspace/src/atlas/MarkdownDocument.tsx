import { useLanguage } from "@/context/language"
import { createMemo, For, Show, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Markdown } from "@synsci/ui/markdown"
import { Popover } from "@synsci/ui/popover"
import { splitAlignedMarkdown } from "./FilePreviewMarkdown"
import {
  documentDefaults,
  readDocumentPreferences,
  writeDocumentPreferences,
  type DocumentPreferences,
} from "./document-preferences"
import "./FilePreview.css"

/** Document-only presentation. Source bytes, sanitization and authorized
 * image/file resolution remain the shared Markdown renderer's responsibility. */
export function MarkdownDocument(
  props: Pick<ComponentProps<typeof Markdown>, "text" | "resolveImage" | "resolveFile" | "onOpenFile"> & {
    name?: string
  },
) {
  const language = useLanguage()
  const [reading, setReading] = createStore(readDocumentPreferences())
  const markdown = createMemo(() => splitAlignedMarkdown(props.text))
  const change = (next: Partial<DocumentPreferences>) => {
    setReading(next)
    writeDocumentPreferences({ ...reading })
  }
  const content = (text: string) => (
    <Markdown
      class="atlas-md"
      text={text}
      resolveImage={props.resolveImage}
      resolveFile={props.resolveFile}
      onOpenFile={props.onOpenFile}
    />
  )

  return (
    <article
      class="atlas-file-document atlas-markdown-document"
      aria-label={
        props.name
          ? language.t("atlas.reading.namedPreview", { name: props.name })
          : language.t("atlas.reading.preview")
      }
      data-reading-font={reading.font}
      data-reading-width={reading.width}
      style={{ "--document-font-size": `${reading.size}px` }}
    >
      <div class="atlas-document-tools">
        <Popover
          title={language.t("atlas.reading.options")}
          description={language.t("atlas.reading.description")}
          placement="bottom-end"
          class="atlas-reading-options"
          triggerAs="button"
          triggerProps={{
            type: "button",
            class: "atlas-file-button atlas-reading-trigger",
            "aria-label": language.t("atlas.reading.options"),
            title: language.t("atlas.reading.options"),
          }}
          trigger={<span aria-hidden="true">Aa</span>}
        >
          <fieldset>
            <legend>{language.t("atlas.reading.size")}</legend>
            <div class="atlas-reading-choices" role="group" aria-label={language.t("atlas.reading.documentSize")}>
              <For each={[13, 15, 17, 19]}>
                {(size) => (
                  <button
                    type="button"
                    aria-label={language.t("atlas.reading.pixels", { size })}
                    aria-pressed={reading.size === size}
                    onClick={() => change({ size })}
                  >
                    {size}
                  </button>
                )}
              </For>
            </div>
          </fieldset>
          <fieldset>
            <legend>{language.t("atlas.reading.font")}</legend>
            <div class="atlas-reading-choices" role="group" aria-label={language.t("atlas.reading.documentFont")}>
              <button type="button" aria-pressed={reading.font === "sans"} onClick={() => change({ font: "sans" })}>
                {language.t("atlas.reading.sans")}
              </button>
              <button type="button" aria-pressed={reading.font === "serif"} onClick={() => change({ font: "serif" })}>
                {language.t("atlas.reading.serif")}
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend>{language.t("atlas.reading.width")}</legend>
            <div class="atlas-reading-choices" role="group" aria-label={language.t("atlas.reading.documentWidth")}>
              <button
                type="button"
                aria-pressed={reading.width === "readable"}
                onClick={() => change({ width: "readable" })}
              >
                {language.t("atlas.reading.readable")}
              </button>
              <button type="button" aria-pressed={reading.width === "full"} onClick={() => change({ width: "full" })}>
                {language.t("atlas.reading.full")}
              </button>
            </div>
          </fieldset>
          <button type="button" class="atlas-reading-reset" onClick={() => change(documentDefaults)}>
            {language.t("atlas.reading.reset")}
          </button>
        </Popover>
      </div>
      <Show when={markdown().lead} fallback={content(props.text)}>
        {(lead) => (
          <div class="atlas-file-document-lead" data-align={lead().alignment}>
            {content(lead().text)}
          </div>
        )}
      </Show>
      <Show when={markdown().lead && markdown().rest}>{(rest) => content(rest())}</Show>
    </article>
  )
}
