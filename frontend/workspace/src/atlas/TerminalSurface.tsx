import { createEffect, createMemo, For, on, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { preloadTerminal, Terminal, type TerminalController, type TerminalSearchResult } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import {
  IconAlertCircle,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTerminal,
  IconX,
} from "@/atlas/shared/Icon"
import { terminalEndpointAvailable } from "@/atlas/terminal-endpoint"
import { useExecutionAuthority } from "@/atlas/use-execution-authority"
import "@/atlas/TerminalSurface.css"

const EMPTY_RESULT: TerminalSearchResult = { current: 0, total: 0 }

export function TerminalSurface(props: { active?: boolean } = {}): JSX.Element {
  preloadTerminal()
  const language = useLanguage()
  const sdk = useSDK()
  const terminal = useTerminal()
  const authority = useExecutionAuthority("terminal")
  const [state, setState] = createStore({
    starting: false,
    connecting: false,
    error: "",
    searching: false,
    query: "",
    result: EMPTY_RESULT,
  })
  const available = createMemo(() => terminalEndpointAvailable(sdk.url))
  const active = createMemo(() => terminal.all().find((item) => item.id === terminal.active()))
  const controls = new Map<string, TerminalController>()
  const search = { input: undefined as HTMLInputElement | undefined }

  const control = () => {
    const id = active()?.id
    if (!id) return
    return controls.get(id)
  }

  const openSearch = () => {
    if (!control()) return
    setState("searching", true)
    queueMicrotask(() => search.input?.focus())
  }

  const closeSearch = () => {
    setState({ searching: false, query: "", result: EMPTY_RESULT })
    control()?.clearSelection()
    control()?.focus()
  }

  const find = (direction: "next" | "previous" = "next") => {
    const next = control()?.search(state.query, direction) ?? EMPTY_RESULT
    setState("result", next)
  }

  createEffect(() => {
    if (!terminal.ready() || terminal.active() || !terminal.all().length) return
    terminal.open(terminal.all()[0].id)
  })

  createEffect(
    on(
      () => active()?.id,
      () => setState("result", EMPTY_RESULT),
    ),
  )

  const launch = (program?: "claude") => {
    if (!available() || state.starting) return
    if (!authority.allowed()) {
      setState("error", authority.message() ?? language.t("pages.surface.terminalDenied"))
      return
    }
    setState({ starting: true, connecting: true, error: "" })
    void terminal
      .new({ program })
      .then(() => setState("error", ""))
      .catch((cause: unknown) => {
        setState({
          connecting: false,
          error: cause instanceof Error ? cause.message : language.t("pages.surface.terminalStartFailed"),
        })
      })
      .finally(() => setState("starting", false))
  }

  const recover = () => {
    const id = active()?.id
    if (!id) {
      launch()
      return
    }
    if (!available() || state.starting || !authority.allowed()) return
    setState({ starting: true, connecting: true, error: "" })
    void terminal
      .clone(id)
      .then((replacement) => {
        if (!replacement) throw new Error(language.t("pages.surface.terminalGone"))
      })
      .catch((cause: unknown) => {
        setState({
          connecting: false,
          error: cause instanceof Error ? cause.message : language.t("pages.surface.terminalReconnectFailed"),
        })
      })
      .finally(() => setState("starting", false))
  }

  const autostart = { requested: false }
  createEffect(() => {
    if (autostart.requested || !available() || !terminal.ready() || terminal.all().length || state.starting) return
    if (!authority.allowed()) return
    autostart.requested = true
    launch()
  })

  return (
    <section class="terminal-surface" aria-label={language.t("pages.surface.sessionTerminal")}>
      <Show when={state.error}>
        {(message) => (
          <div class="terminal-surface__error" role="alert">
            <IconAlertCircle size={14} strokeWidth={1.5} />
            <span>{message()}</span>
            <button type="button" onClick={recover} disabled={state.starting || !authority.allowed()}>
              <IconRefresh size={12} strokeWidth={1.5} />
              {state.starting ? language.t("pages.surface.retrying") : language.t("settings.copy.tryAgain")}
            </button>
          </div>
        )}
      </Show>

      <Show when={available() ? authority.message() : undefined}>
        {(message) => (
          <div class="terminal-surface__authority" role={authority.decision.error ? "alert" : "status"}>
            {message()}
          </div>
        )}
      </Show>

      <Show
        when={available()}
        fallback={
          <div class="terminal-surface__empty">
            <span class="terminal-surface__empty-mark" aria-hidden="true">
              <IconTerminal size={16} strokeWidth={1.5} />
            </span>
            <strong>{language.t("pages.surface.localTerminalUnavailable")}</strong>
            <p>{language.t("pages.surface.localTerminalUnavailableHint")}</p>
          </div>
        }
      >
        <Show
          when={terminal.ready()}
          fallback={
            <div class="terminal-surface__empty" aria-live="polite">
              <span class="terminal-surface__eyebrow">{language.t("pages.surface.preparingTerminal")}</span>
            </div>
          }
        >
          <Show
            when={terminal.all().length}
            fallback={
              <div class="terminal-surface__empty">
                <span class="terminal-surface__empty-mark" aria-hidden="true">
                  <IconTerminal size={16} strokeWidth={1.5} />
                </span>
                <strong>{language.t("pages.surface.projectTerminal")}</strong>
                <p>{language.t("pages.surface.startTerminalHint")}</p>
                <button
                  type="button"
                  onClick={() => launch()}
                  disabled={state.starting || !authority.allowed()}
                  title={authority.message()}
                  data-modal-initial-focus
                >
                  {state.starting ? language.t("settings.copy.starting") : language.t("pages.surface.startTerminal")}
                </button>
              </div>
            }
          >
            <div class="terminal-surface__tabs-row">
              <nav class="terminal-surface__tabs" role="tablist" aria-label={language.t("pages.surface.openTerminals")}>
                <For each={terminal.all()}>
                  {(pty) => (
                    <div class="terminal-surface__tab-shell" data-active={active()?.id === pty.id ? "true" : undefined}>
                      <button
                        type="button"
                        class="terminal-surface__tab"
                        role="tab"
                        aria-selected={active()?.id === pty.id}
                        aria-controls={`terminal-wrapper-${pty.id}`}
                        onClick={() => terminal.open(pty.id)}
                      >
                        {pty.title}
                      </button>
                      <button
                        type="button"
                        class="terminal-surface__close"
                        aria-label={language.t("pages.copy.closeNamed", { name: pty.title })}
                        onClick={() => void terminal.close(pty.id)}
                      >
                        <IconX size={10} strokeWidth={1.5} />
                      </button>
                    </div>
                  )}
                </For>
              </nav>
              <button
                type="button"
                class="terminal-surface__new"
                onClick={() => launch("claude")}
                disabled={!available() || state.starting || !authority.allowed()}
                title={authority.message() ?? language.t("terminal.claude.description")}
                aria-label={language.t("terminal.claude.open")}
              >
                <IconTerminal size={12} strokeWidth={1.5} />
                <span>Claude Code</span>
              </button>
              <button
                type="button"
                class="terminal-surface__new"
                onClick={() => launch()}
                disabled={!available() || state.starting || !authority.allowed()}
                title={authority.message() ?? language.t("command.terminal.new")}
                aria-label={
                  state.starting ? language.t("pages.surface.startingTerminal") : language.t("command.terminal.new")
                }
              >
                <IconPlus size={12} strokeWidth={1.5} />
                <span>{state.starting ? language.t("settings.copy.starting") : language.t("pages.copy.new")}</span>
              </button>
            </div>

            <Show when={state.searching}>
              <form
                class="terminal-surface__search"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault()
                  find("next")
                }}
              >
                <IconSearch size={12} strokeWidth={1.5} />
                <input
                  ref={(node) => (search.input = node)}
                  type="search"
                  value={state.query}
                  placeholder={language.t("pages.surface.findOutput")}
                  aria-label={language.t("pages.surface.findTerminalOutput")}
                  autocomplete="off"
                  onInput={(event) => {
                    setState("query", event.currentTarget.value)
                    find()
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return
                    event.preventDefault()
                    closeSearch()
                  }}
                />
                <span class="terminal-surface__search-count" aria-live="polite">
                  {state.query ? `${state.result.current}/${state.result.total}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => find("previous")}
                  aria-label={language.t("pages.surface.previousMatch")}
                  title={language.t("pages.surface.previousMatch")}
                >
                  <IconChevronLeft size={12} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => find("next")}
                  aria-label={language.t("pages.surface.nextMatch")}
                  title={language.t("pages.surface.nextMatch")}
                >
                  <IconChevronRight size={12} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={closeSearch}
                  aria-label={language.t("pages.surface.closeSearch")}
                  title={language.t("pages.surface.closeSearchEsc")}
                >
                  <IconX size={12} strokeWidth={1.5} />
                </button>
              </form>
            </Show>

            <div class="terminal-surface__viewport">
              <Show when={state.connecting}>
                <div class="terminal-surface__connecting" role="status" aria-live="polite">
                  <span class="terminal-surface__connecting-mark" aria-hidden="true">
                    <IconTerminal size={14} strokeWidth={1.5} />
                  </span>
                  <span>{language.t("pages.surface.startingTerminalEllipsis")}</span>
                </div>
              </Show>
              <For each={terminal.all()}>
                {(pty) => (
                  <div
                    id={`terminal-wrapper-${pty.id}`}
                    class="terminal-surface__terminal"
                    role="tabpanel"
                    aria-label={pty.title}
                    aria-hidden={active()?.id === pty.id ? undefined : "true"}
                    data-active={active()?.id === pty.id ? "true" : "false"}
                  >
                    <Terminal
                      pty={pty}
                      active={props.active !== false && active()?.id === pty.id}
                      onReady={(controller) => {
                        if (controller) controls.set(pty.id, controller)
                        if (!controller) controls.delete(pty.id)
                      }}
                      onOpenSearch={openSearch}
                      onCleanup={(next) => terminal.update(next)}
                      onConnect={() => {
                        setState({ connecting: false, error: "" })
                      }}
                      onConnectError={(cause) => {
                        setState({ connecting: false, error: cause.message })
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
