import { useLanguage } from "@/context/language"
import type { JSX } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { composerOverlays, registerOverlayDetails } from "./overlay-group"
import "./prompt-input.css"

/**
 * The composer's Tools menu: the `<details>`, its summary, and the line that
 * joins the one-open-overlay group. The body belongs to the composer, which
 * reads its whole session context; this shell does not, so the registration
 * that closes Tools when another composer menu opens can be mounted — and
 * tested — without it.
 */
export function ComposerTools(props: {
  children: JSX.Element
  /** The menu element, for the composer's own reach into its open sub-menus. */
  ref?: (element: HTMLDetailsElement) => void
  /** Called when the menu closes, whoever closed it. */
  onClose?: () => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <details
      ref={(element) => {
        props.ref?.(element)
        registerOverlayDetails(composerOverlays, "tools", element)
      }}
      class="workspace-composer__research-tools"
      data-composer-tools
      onToggle={(event) => {
        if (event.currentTarget.open) return
        props.onClose?.()
      }}
    >
      <summary aria-label={language.t("interface.composer.tools")}>
        <span class="workspace-composer__research-tools-label">{language.t("interface.composer.tools")}</span>
        <Icon name="chevron-down" size="small" />
      </summary>
      <div
        class="workspace-composer__research-tools-menu"
        role="group"
        aria-label={language.t("interface.composer.tools")}
      >
        {props.children}
      </div>
    </details>
  )
}
