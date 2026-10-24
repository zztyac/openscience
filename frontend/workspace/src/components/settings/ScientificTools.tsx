import { scientificSummaryCopy, scientificCategoryCopy } from "./catalog-copy"
import { useLanguage } from "@/context/language"
import { Button } from "@synsci/ui/button"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { EmptyState, PanelBody, PanelHeader, PanelScroll, RowCopy, Section } from "./_shared"
import { useSettingsNav } from "./nav"
import {
  actionableScientificCapabilities,
  capabilityNote,
  capabilityState,
  hostedOnly,
  scientificCapabilityTarget,
  type ScientificCapabilityRecord,
  type ScientificToolsResponse,
} from "./scientific-tools-state"
import { loadScientificTools, setupScientificTool } from "./scientific-tools-loader"
import "./scientific-tools.css"
import { ScientificToolLogo } from "./ScientificToolLogo"

export default function ScientificTools() {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const navigate = useSettingsNav()
  const [state, setState] = createSignal<ScientificToolsResponse>()
  const [problem, setProblem] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [installing, setInstalling] = createSignal<string>()
  const fetchFn = () => platform.fetch ?? fetch

  async function load(refresh = false) {
    setLoading(true)
    if (!refresh) setProblem("")
    try {
      setState(await loadScientificTools(server.url, fetchFn(), refresh))
      setProblem("")
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function install(record: ScientificCapabilityRecord) {
    setInstalling(record.id)
    setProblem("")
    setNotice("")
    try {
      await setupScientificTool(server.url, fetchFn(), record.id)
      await load(true)
      setNotice(language.t("settings.copy.science.ready", { name: record.name }))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setInstalling(undefined)
    }
  }

  onMount(() => void load())

  const records = createMemo(() => actionableScientificCapabilities(state()?.capabilities ?? []))
  const local = createMemo(() => records().filter((record) => scientificCapabilityTarget(record) === "local"))
  const hosted = createMemo(() =>
    records().filter((record) => {
      const target = scientificCapabilityTarget(record)
      return target === "nvidia" || target === "modal"
    }),
  )
  // Packaged tools this device cannot install, listed here because Modal is
  // their only route; the header says so before the rows repeat it.
  const modalOnly = createMemo(() => hosted().filter(hostedOnly).length)
  const hostedDescription = () =>
    [
      language.t("settings.copy.science.hosted", { count: hosted().length }),
      modalOnly() > 0 ? language.t("settings.copy.science.modalOnly", { count: modalOnly() }) : "",
      language.t("settings.copy.nvidiaToolsShareOneApiKeyInCredentials"),
    ]
      .filter(Boolean)
      .join(" ")

  return (
    <PanelScroll>
      <div class="scientific-tools-panel">
        <PanelHeader
          title={language.t("settings.shell.panel.scientific-tools")}
          description={language.t("settings.copy.scientificToolsYouCanRunHereOrConnect")}
        />
        <PanelBody>
          <Show when={problem()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              <span>{problem()}</span>
              <Show when={!state()}>
                <Button
                  size="small"
                  variant="secondary"
                  class="settings-panel-action"
                  disabled={loading()}
                  onClick={() => void load(true)}
                >
                  {language.t("settings.connectors.retry")}
                </Button>
              </Show>
            </div>
          </Show>

          <Show when={notice()}>
            <div class="scientific-tools-notice" role="status" aria-live="polite">
              {notice()}
            </div>
          </Show>

          <Show when={loading() && !state()}>
            <div
              class="settings-panel-loading__rows"
              role="status"
              aria-label={language.t("settings.copy.loadingTools")}
            >
              <span />
              <span />
              <span />
            </div>
          </Show>

          <Show when={state()}>
            <Show
              when={records().length > 0}
              fallback={
                <EmptyState
                  icon="flask"
                  title={language.t("settings.copy.noRunnableToolsForThisDevice")}
                  hint={language.t("settings.copy.openscienceOnlyListsToolsWithARealPackaged")}
                />
              }
            >
              <Show when={local().length > 0}>
                <Section
                  id="scientific-tools-local"
                  title={language.t("settings.copy.localScience")}
                  description={language.t("settings.copy.science.local", { count: local().length })}
                >
                  <div class="settings-card scientific-tools-list" role="list">
                    <For each={local()}>
                      {(record) => (
                        <CapabilityRow
                          record={record}
                          busy={Boolean(installing())}
                          active={installing() === record.id}
                          onAction={() => void install(record)}
                          onOpenSource={() => platform.openLink(record.source.reference)}
                        />
                      )}
                    </For>
                  </div>
                </Section>
              </Show>

              <Show when={hosted().length > 0}>
                <Section
                  id="scientific-tools-connected"
                  title={language.t("settings.copy.connectedScience")}
                  description={hostedDescription()}
                >
                  <div class="settings-card scientific-tools-list" role="list">
                    <For each={hosted()}>
                      {(record) => {
                        const target = () => scientificCapabilityTarget(record)
                        return (
                          <CapabilityRow
                            record={record}
                            busy={false}
                            active={false}
                            onAction={() => navigate(target() === "modal" ? "compute" : "credentials")}
                            onOpenSource={() => platform.openLink(record.source.reference)}
                          />
                        )
                      }}
                    </For>
                  </div>
                </Section>
              </Show>
            </Show>

            <p class="scientific-tools-footnote">
              {language.t("settings.copy.onlyExecutableAdaptersAreListedRunsUseThis")}
            </p>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

function CapabilityRow(props: {
  record: ScientificCapabilityRecord
  busy: boolean
  active: boolean
  onAction: () => void
  onOpenSource: () => void
}) {
  const language = useLanguage()
  const status = () => capabilityState(props.record, language.t)
  const target = () => scientificCapabilityTarget(props.record)
  const actionLabel = () => {
    if (props.active) return language.t("settings.copy.installing")
    if (status().action === "setup")
      return status().tone === "warning" ? language.t("settings.copy.repair") : language.t("settings.copy.install")
    if (status().action === "credentials")
      return status().tone === "warning" ? language.t("settings.copy.review") : language.t("settings.copy.connect")
    if (status().action === "compute")
      return status().tone === "warning" ? language.t("settings.copy.review") : language.t("settings.copy.connectModal")
    return undefined
  }
  const note = () => capabilityNote(props.record, language.t)
  return (
    <article class="settings-row settings-row--grammar scientific-tool-row" data-target={target()} role="listitem">
      <span class="settings-row-logo">
        <ScientificToolLogo id={props.record.id} name={props.record.name} hosted={target() === "nvidia"} />
      </span>
      <RowCopy
        title={props.record.name}
        description={
          <>
            {scientificCategoryCopy(props.record.category, language.t)} ·{" "}
            {scientificSummaryCopy(props.record, language.t)}
            <Show when={note()}>{(text) => <> {text()}</>}</Show>{" "}
            <button
              type="button"
              class="settings-inline-link"
              aria-label={language.t("settings.copy.science.source", { name: props.record.name })}
              onClick={props.onOpenSource}
            >
              {language.t("settings.copy.source")}
            </button>
          </>
        }
      />
      <span class="settings-row-status scientific-tool-status" data-tone={status().tone}>
        {status().label}
      </span>
      <Show when={actionLabel()}>
        {(label) => (
          <div class="settings-row-control">
            <Button
              class="scientific-tool-action"
              size="small"
              variant="secondary"
              disabled={props.busy}
              onClick={props.onAction}
            >
              {label()}
            </Button>
          </div>
        )}
      </Show>
    </article>
  )
}
