import { useLanguage } from "@/context/language"
import { Show, type JSX } from "solid-js"
import { IconCpu, IconFolder, IconTerminal, IconActivity } from "@/atlas/shared/Icon"
import { preloadTerminal } from "@/components/terminal"
import "./session-sidebar.css"

export type SessionContext = "files" | "terminal" | "canvas" | "kernels" | "autoresearch" | "trace" | "artifact"

export function CompactContextActions(props: {
  context: SessionContext
  contextOpen: boolean
  onContext: (context: SessionContext) => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <div class="workspace-header__context-actions" style={{ display: "contents" }}>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "files" && props.contextOpen}
        onClick={() => props.onContext("files")}
      >
        <IconFolder size={16} strokeWidth={1.5} />
        {language.t("palette.group.files")}
      </button>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "terminal" && props.contextOpen}
        onPointerEnter={preloadTerminal}
        onFocus={preloadTerminal}
        onClick={() => props.onContext("terminal")}
      >
        <IconTerminal size={16} strokeWidth={1.5} />
        {language.t("terminal.title")}
      </button>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "kernels" && props.contextOpen}
        onClick={() => props.onContext("kernels")}
      >
        <IconCpu size={16} strokeWidth={1.5} />
        {language.t("settings.shell.panel.compute")}
      </button>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "autoresearch" && props.contextOpen}
        onClick={() => props.onContext("autoresearch")}
      >
        <IconActivity size={16} strokeWidth={1.5} />
        {language.t("pages.copy.autoresearch")}
      </button>
    </div>
  )
}

export function SidebarAction(props: {
  class?: string
  label: string
  detail: string
  ariaLabel: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onWarm?: () => void
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      class={`session-sidebar__action${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.ariaLabel}
      data-tooltip={props.label}
      aria-pressed={props.active === undefined ? undefined : props.active}
      data-selected={props.active ? "true" : undefined}
      disabled={props.disabled}
      onPointerEnter={() => props.onWarm?.()}
      onFocus={() => props.onWarm?.()}
      onClick={() => props.onClick()}
    >
      <span class="session-sidebar__action-icon" aria-hidden="true">
        {props.children}
      </span>
      <span class="session-sidebar__action-copy">
        <strong>{props.label}</strong>
        <span>{props.detail}</span>
      </span>
      <Show when={props.shortcut}>
        <kbd aria-hidden="true">{props.shortcut}</kbd>
      </Show>
    </button>
  )
}

export function SessionSidebarActions(props: {
  context: SessionContext
  contextOpen: boolean
  onContext: (context: SessionContext) => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <div class="session-sidebar__context-actions">
      <div class="session-sidebar__group-label" aria-hidden="true">
        {language.t("command.category.workspace")}
      </div>
      <div class="session-sidebar__action-list">
        <SidebarAction
          label={language.t("palette.group.files")}
          detail={language.t("pages.copy.projectFiles")}
          ariaLabel={language.t("pages.copy.openProjectFiles")}
          active={props.context === "files" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("files")}
        >
          <IconFolder size={16} strokeWidth={1.5} />
        </SidebarAction>
        <SidebarAction
          label={language.t("terminal.title")}
          detail={language.t("pages.copy.projectShell")}
          ariaLabel={language.t("pages.copy.openProjectTerminal")}
          shortcut="⌃`"
          active={props.context === "terminal" && props.contextOpen}
          onWarm={preloadTerminal}
          onClick={(_event?: Event) => props.onContext("terminal")}
        >
          <IconTerminal size={16} strokeWidth={1.5} />
        </SidebarAction>
        <SidebarAction
          label={language.t("settings.shell.panel.compute")}
          detail={language.t("pages.copy.runtimesJobs")}
          ariaLabel={language.t("pages.copy.openProjectCompute")}
          active={props.context === "kernels" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("kernels")}
        >
          <IconCpu size={16} strokeWidth={1.5} />
        </SidebarAction>
        <SidebarAction
          label={language.t("pages.copy.autoresearch")}
          detail={language.t("pages.copy.studiesRuns")}
          ariaLabel={language.t("pages.copy.openProjectAutoresearch")}
          active={props.context === "autoresearch" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("autoresearch")}
        >
          <IconActivity size={16} strokeWidth={1.5} />
        </SidebarAction>
      </div>
    </div>
  )
}
