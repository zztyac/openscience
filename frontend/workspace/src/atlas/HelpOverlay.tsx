import { useLanguage } from "@/context/language"
import { createEffect, type JSX, For, onCleanup } from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { FONT_SANS } from "@/styles/tokens"
import { IconX } from "@/atlas/shared/Icon"
import { AgentIcon } from "@/atlas/shared/AgentIcon"
import { useCommand } from "@/context/command"

interface HelpOverlayProps {
  open: boolean
  onClose: () => void
}

export function HelpOverlay(props: HelpOverlayProps): JSX.Element {
  const language = useLanguage()
  const sections = (): Array<{ title: string; rows: Array<{ keys: string[]; label: string }> }> => [
    {
      title: language.t("settings.shortcuts.group.navigation"),
      rows: [
        { keys: ["⌘", "K"], label: language.t("pages.overlay.openPalette") },
        { keys: ["⌘", "N"], label: language.t("pages.overlay.createProjectOrSession") },
        { keys: ["?"], label: language.t("pages.overlay.openShortcuts") },
      ],
    },
    {
      title: language.t("pages.overlay.chat"),
      rows: [
        { keys: ["↵"], label: language.t("pages.overlay.sendMessage") },
        { keys: ["⇧", "↵"], label: language.t("pages.overlay.newLine") },
        { keys: ["/"], label: language.t("pages.overlay.openSkillsCommands") },
        { keys: ["Esc"], label: language.t("pages.overlay.closeDialog") },
      ],
    },
    {
      title: language.t("pages.copy.sessions"),
      rows: [{ keys: ["Double-click"], label: language.t("pages.overlay.renameSessionHelp") }],
    },
  ]

  const command = useCommand()
  let closeRef: HTMLButtonElement | undefined
  let restoreFocus: HTMLElement | undefined

  createEffect(() => {
    if (!props.open) return
    command.keybinds(false)
    onCleanup(() => command.keybinds(true))
  })

  return (
    <Kobalte
      modal
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <Kobalte.Portal>
        <Kobalte.Overlay class="atlas-overlay" />
        <Kobalte.Content
          class="atlas-modal"
          role="dialog"
          aria-modal="true"
          style={{ width: "560px", "max-width": "94vw" }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const active = document.activeElement
            restoreFocus = active instanceof HTMLElement && active !== document.body ? active : undefined
            closeRef?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (restoreFocus?.isConnected) restoreFocus.focus()
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              padding: "16px 20px",
              "border-bottom": "1px solid var(--color-border)",
            }}
          >
            <AgentIcon size={20} strokeWidth={1.5} />
            <Kobalte.Title
              style={{
                "font-family": FONT_SANS,
                "font-size": "22px",
                "font-weight": "var(--font-weight-medium)",
                "line-height": 1.2,
                "letter-spacing": "-0.01em",
                margin: 0,
                color: "var(--color-text)",
              }}
            >
              {language.t("settings.shortcuts.title")}
            </Kobalte.Title>
            <span style={{ flex: 1 }} />
            <Kobalte.CloseButton
              ref={closeRef}
              type="button"
              aria-label={language.t("pages.overlay.closeShortcuts")}
              style={{
                all: "unset",
                "box-sizing": "border-box",
                cursor: "pointer",
                color: "var(--color-text-faint)",
                display: "inline-flex",
                width: "40px",
                height: "40px",
                "align-items": "center",
                "justify-content": "center",
                "border-radius": "6px",
              }}
            >
              <IconX size={14} strokeWidth={1.5} />
            </Kobalte.CloseButton>
          </div>
          <div
            class="atlas-scroll"
            style={{
              padding: "20px 24px",
              "max-height": "70vh",
              "overflow-y": "auto",
              display: "flex",
              "flex-direction": "column",
              gap: "20px",
            }}
          >
            <For each={sections()}>
              {(section) => (
                <section style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <div
                    style={{
                      "font-family": FONT_SANS,
                      "font-size": "10px",
                      "letter-spacing": "normal",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    {section.title}
                  </div>
                  <For each={section.rows}>
                    {(row) => (
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "10px",
                          padding: "4px 0",
                        }}
                      >
                        <div style={{ display: "flex", gap: "3px", "min-width": "92px" }}>
                          <For each={row.keys}>
                            {(k) => (
                              <kbd
                                style={{
                                  "font-family": FONT_SANS,
                                  "font-size": "10px",
                                  padding: "2px 6px",
                                  border: "1px solid var(--color-border)",
                                  "border-bottom-width": "2px",
                                  "border-radius": "4px",
                                  background: "var(--color-bg-subtle)",
                                  color: "var(--color-text-muted)",
                                }}
                              >
                                {k === "Double-click" ? language.t("pages.overlay.doubleClick") : k}
                              </kbd>
                            )}
                          </For>
                        </div>
                        <span
                          style={{
                            "font-family": FONT_SANS,
                            "font-size": "13px",
                            color: "var(--color-text-muted)",
                            flex: 1,
                          }}
                        >
                          {row.label}
                        </span>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
