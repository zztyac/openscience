import { useLanguage } from "@/context/language"
// Local models settings panel — add an Ollama / LM Studio / OpenAI-compatible
// endpoint running on this machine. The server (routes/settings/local.ts) does
// the localhost probing/listing the browser can't do cross-origin, and writes
// the provider config block.
import { Component, For, Show, createEffect, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Checkbox } from "@synsci/ui/checkbox"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { productPreferences } from "@/context/product-preferences"
import { useModels } from "@/context/models"
import { settingsApi } from "./api"
import { prepareOllamaModels, selectableLocalModels } from "./local-model-selection"
import { Card, PanelBody, PanelHeader, PanelScroll, RowCopy, Section, steady } from "./_shared"

interface Detected {
  id: string
  name: string
  baseURL: string
  models: string[]
}
interface Configured {
  id: string
  name: string
  baseURL: string
  models: string[]
  runtime?: string
}
interface Runtime {
  id: string
  name: string
  baseURL: string
  installed: boolean
  running: boolean
  models: string[]
  install: string
  serveHint: string
}

type Source = Pick<Detected, "id" | "name" | "baseURL" | "models">

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const LocalModels: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch

  const copyCommand = (command: string) => {
    if (!navigator.clipboard) {
      showToast({
        title: "Couldn't copy command",
        description: language.t("settings.copy.clipboardAccessIsUnavailable"),
      })
      return
    }
    return navigator.clipboard.writeText(command).then(
      () => showToast({ title: language.t("settings.copy.commandCopied"), description: command }),
      (error) => showToast({ title: "Couldn't copy command", description: message(error) }),
    )
  }
  const call = <T,>(path: string, init?: RequestInit) =>
    settingsApi<T>(sdk.url, fetchFn, `/settings/local${path}`, init)

  const [detected, { refetch: refetchDetected }] = steady(
    createResource(() => call<{ detected: Detected[] }>("/detect").then((r) => r.detected)),
  )
  const [configured, { refetch: refetchConfigured }] = steady(
    createResource(() => call<{ providers: Configured[] }>("").then((r) => r.providers)),
  )
  const [status, { refetch: refetchStatus }] = steady(
    createResource(() => call<{ runtimes: Runtime[] }>("/status").then((r) => r.runtimes)),
  )
  const [preferences, { mutate: setPreferences }] = steady(
    createResource(() => settingsApi<{ show_local_models: boolean }>(sdk.url, fetchFn, "/settings/preferences")),
  )
  createEffect(() => {
    const value = preferences()?.show_local_models
    if (value !== undefined) productPreferences.sync({ show_local_models: value })
  })
  const discoveries = createMemo(
    () => detected()?.filter((item) => !status()?.some((runtime) => runtime.id === item.id && runtime.running)) ?? [],
  )
  const refetch = () => {
    refetchDetected()
    refetchConfigured()
    refetchStatus()
  }

  // Load failures and action failures surface inline, like Models, instead of
  // disappearing into a toast.
  const [error, setError] = createSignal<string>()
  const problem = () => error() ?? [detected, configured, status].find((resource) => resource.error)?.error
  const recover = () => {
    setError(undefined)
    refetch()
  }

  const models = useModels()
  const [busy, setBusy] = createSignal(false)
  const [context, setContext] = createSignal("32768")
  // The picker only surfaces a curated frontier set by default. A model the
  // user just added by hand must show up there, or the add looks like a no-op.
  const reveal = (providerID: string, added: string[]) => {
    for (const modelID of added) models.setVisibility({ providerID, modelID }, true)
  }
  const contextTokens = () => {
    const tokens = Number(context())
    if (!Number.isInteger(tokens) || tokens < 1_024 || tokens > 2_097_152) {
      throw new Error(language.t("settings.copy.contextMustBeAnIntegerBetween1024"))
    }
    return tokens
  }
  const guard = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      refetch()
    } catch (err) {
      setError(`${failure}. ${message(err)}`)
    }
    setBusy(false)
  }

  const isOllama = (id: string | undefined, url: string) => {
    if (id === "ollama") return true
    try {
      return new URL(url).port === "11434"
    } catch {
      return false
    }
  }
  const register = async (input: { url: string; models: string[]; id?: string; name?: string; key?: string }) => {
    const ollama = isOllama(input.id, input.url)
    const tokens = contextTokens()
    const prepared = ollama
      ? await prepareOllamaModels(input.models, (model) =>
          call<{ model: string }>("/context", {
            method: "POST",
            body: JSON.stringify({ url: input.url, model, context: tokens }),
          }).then((result) => result.model),
        )
      : { models: input.models, aliases: {}, tuned: true }
    const result = await call<{ id: string; baseURL: string; models: string[] }>("", {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        id: input.id,
        name: input.name,
        key: input.key,
        models: prepared.models,
        aliases: prepared.aliases,
        contextLimit: tokens,
        runtime: ollama ? "ollama" : undefined,
        merge: true,
      }),
    })
    return { ...result, tuned: prepared.tuned }
  }

  const [choice, setChoice] = createSignal<Source>()
  const [chosen, setChosen] = createSignal<Set<string>>(new Set<string>())
  const choose = (source: Source) => {
    setChoice({ ...source, models: selectableLocalModels(source.models) })
    setChosen(new Set<string>())
  }
  const toggleChoice = (model: string) => {
    const next = new Set(chosen())
    next.has(model) ? next.delete(model) : next.add(model)
    setChosen(next)
  }
  const addChoice = () =>
    guard(async () => {
      const source = choice()
      if (!source) return
      const models = source.models.filter((model) => chosen().has(model))
      if (!models.length) throw new Error(language.t("settings.copy.selectAtLeastOneModel"))
      const result = await register({
        url: source.baseURL,
        id: source.id,
        name: `${source.name} (local)`,
        models,
      })
      await sync.refreshProviders()
      reveal(result.id, models)
      showToast({
        variant: "success",
        title: models.length === 1 ? language.t("settings.copy.modelAdded") : language.t("settings.copy.modelsAdded"),
        description: result.tuned
          ? `${models.length} model(s) are now available in the model picker.`
          : `${models.length} model(s) are now available in the model picker. Restart the local server to enable custom Ollama context tuning.`,
      })
      setChoice(undefined)
      setChosen(new Set<string>())
    }, "Couldn't add local models")

  const removeProvider = (id: string) =>
    guard(async () => {
      await call(`/${encodeURIComponent(id)}`, { method: "DELETE" })
      await sync.refreshProviders()
    }, "Couldn't remove the provider")

  const [visibilityBusy, setVisibilityBusy] = createSignal(false)
  const setVisibility = (visible: boolean) => {
    if (visibilityBusy()) return
    const previous = productPreferences.localModels()
    productPreferences.sync({ show_local_models: visible })
    setVisibilityBusy(true)
    void settingsApi<{ show_local_models: boolean }>(sdk.url, fetchFn, "/settings/preferences", {
      method: "PATCH",
      body: JSON.stringify({ show_local_models: visible }),
    })
      .then((value) => {
        setPreferences(value)
        productPreferences.sync(value)
      })
      .catch((cause) => {
        productPreferences.sync({ show_local_models: previous })
        setError(`Couldn't update model visibility. ${message(cause)}`)
      })
      .finally(() => setVisibilityBusy(false))
  }

  // ── Start a runtime for the user (host it) ──
  const [starting, setStarting] = createSignal<string>()
  const startRuntime = async (rt: Runtime) => {
    setStarting(rt.id)
    setError(undefined)
    try {
      const r = await call<{
        id: string
        running: boolean
        installed?: boolean
        install?: string
        models?: string[]
      }>("/start", { method: "POST", body: JSON.stringify({ id: rt.id }) })
      if (r.installed === false) {
        showToast({ title: `${rt.name} isn't installed`, description: `Install it, then start it here.` })
        window.open(r.install ?? rt.install, "_blank", "noopener")
      } else if (r.running && r.models?.length) {
        choose({ ...rt, models: r.models })
        showToast({ title: `${rt.name} is running`, description: language.t("settings.copy.chooseWhichModelsToAdd") })
      } else if (r.running) {
        showToast({
          title: `${rt.name} is running`,
          description: language.t("settings.copy.noModelsYetPullOneBelowThenRescan"),
        })
      } else {
        setError(`Couldn't start ${rt.name}. The server didn't come up in time.`)
      }
      refetch()
    } catch (err) {
      setError(`Couldn't start ${rt.name}. ${message(err)}`)
    }
    setStarting(undefined)
  }

  // ── Pull a model ──
  const [pullName, setPullName] = createSignal("")
  const pull = () => {
    const m = pullName().trim()
    if (!m) return
    void copyCommand(`ollama pull ${m}`)
  }

  // ── Custom endpoint flow ──
  const [url, setUrl] = createSignal("")
  const [key, setKey] = createSignal("")
  const [found, setFound] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal<Set<string>>(new Set<string>())
  const [listedUrl, setListedUrl] = createSignal("")
  const [sshOpen, setSshOpen] = createSignal(false)
  const [directOpen, setDirectOpen] = createSignal(false)
  const [sshHost, setSshHost] = createSignal("")
  const [sshRemotePort, setSshRemotePort] = createSignal("11434")
  const [sshLocalPort, setSshLocalPort] = createSignal("12434")
  const [sshKey, setSshKey] = createSignal("")

  const connectSSH = () =>
    guard(async () => {
      const remotePort = Number(sshRemotePort())
      const localPort = Number(sshLocalPort())
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
        throw new Error(language.t("settings.copy.remotePortMustBeBetween1And65"))
      }
      if (!Number.isInteger(localPort) || localPort < 1_024 || localPort > 65_535) {
        throw new Error(language.t("settings.copy.localPortMustBeBetween1024And"))
      }
      const contextLimit = contextTokens()
      const result = await call<{ id: string; models: string[] }>("/ssh", {
        method: "POST",
        body: JSON.stringify({
          host: sshHost().trim(),
          remotePort,
          localPort,
          key: sshKey().trim() || undefined,
          contextLimit,
        }),
      })
      await sync.refreshProviders()
      reveal(result.id, result.models)
      showToast({
        variant: "success",
        title: language.t("settings.copy.sshModelsConnected"),
        description: `${result.models.length} model(s) are now available in the model picker through the encrypted tunnel.`,
      })
    }, "Couldn't connect the SSH model host")

  const listCustom = () =>
    guard(async () => {
      const r = await call<{ baseURL: string; models: string[]; error?: string }>("/models", {
        method: "POST",
        body: JSON.stringify({ url: url().trim(), key: key().trim() || undefined }),
      })
      if (r.error || !r.models.length) {
        showToast({
          title: language.t("settings.copy.noModelsFound"),
          description: r.error ?? language.t("settings.copy.theEndpointReturnedNoModels"),
        })
      }
      setFound(r.models)
      setSelected(new Set(r.models))
      setListedUrl(r.baseURL)
    }, "Couldn't reach the endpoint")

  const toggle = (m: string) => {
    const next = new Set(selected())
    next.has(m) ? next.delete(m) : next.add(m)
    setSelected(next)
  }

  const addCustom = () =>
    guard(async () => {
      const models = [...selected()]
      if (!models.length) throw new Error(language.t("settings.copy.selectAtLeastOneModel"))
      const result = await register({ url: url().trim(), key: key().trim() || undefined, models })
      await sync.refreshProviders()
      reveal(result.id, models)
      showToast({
        variant: "success",
        title: models.length === 1 ? language.t("settings.copy.modelAdded") : language.t("settings.copy.modelsAdded"),
        description: `${models.length} model(s) are now available in the model picker.`,
      })
      setUrl("")
      setKey("")
      setFound([])
      setSelected(new Set<string>())
      setListedUrl("")
    }, "Couldn't add local models")

  const runtimeDetail = (rt: Runtime) => {
    if (!rt.installed) return `Not installed · ${rt.serveHint}`
    if (rt.running) return `Running · ${rt.models.length} model(s)`
    return language.t("settings.copy.installedNotRunning")
  }

  return (
    <PanelScroll>
      <PanelHeader
        title={language.t("settings.shell.panel.local-models")}
        description={language.t("settings.copy.runModelsOnThisMachineOrConnectA")}
      />
      <PanelBody>
        <Show when={problem()}>
          {(value) => (
            <div role="alert" class="settings-alert" data-tone="critical">
              <span>{String(value())}</span>
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action"
                disabled={busy()}
                onClick={recover}
              >
                {language.t("settings.connectors.retry")}
              </Button>
            </div>
          )}
        </Show>

        <Section
          title={language.t("settings.copy.catalog")}
          description={language.t("settings.copy.modelsYouAddHereAppearInTheModel")}
        >
          <Card>
            <div class="settings-row">
              <RowCopy
                title={language.t("settings.copy.showLocalModelsInModels")}
                description={language.t("settings.copy.hideLocallyHostedModelsFromTheCatalogWithout")}
              />
              <Switch
                hideLabel
                checked={productPreferences.localModels()}
                disabled={visibilityBusy() || preferences.loading}
                onChange={setVisibility}
              >
                {language.t("settings.copy.showLocalModelsInModels")}
              </Switch>
            </div>
          </Card>
        </Section>

        {/* ── Run locally (host it for the user) ── */}
        <Section
          title={language.t("settings.copy.runAModelLocally")}
          description={language.t("settings.copy.openscienceStartsAndHostsARuntimeForYou")}
        >
          <Card>
            <Show
              when={!status.loading}
              fallback={
                <div
                  class="settings-panel-loading__rows"
                  role="status"
                  aria-label={language.t("settings.copy.loadingLocalRuntimes")}
                >
                  <span />
                  <span />
                </div>
              }
            >
              <For
                each={status()}
                fallback={
                  <p class="settings-card-empty" role="status">
                    {language.t("settings.copy.noSupportedLocalRuntimeWasFoundOnThis")}
                  </p>
                }
              >
                {(rt) => (
                  <div class="settings-row">
                    <RowCopy title={rt.name} description={runtimeDetail(rt)} />
                    <div class="ml-auto flex max-w-full shrink-0 items-center gap-2">
                      <Show when={rt.running}>
                        <span class="settings-row-status">{language.t("settings.copy.running")}</span>
                      </Show>
                      <Show
                        when={rt.installed}
                        fallback={
                          <Button
                            size="small"
                            variant="secondary"
                            class="settings-panel-action"
                            onClick={() => window.open(rt.install, "_blank", "noopener")}
                          >
                            {language.t("settings.copy.install")}
                          </Button>
                        }
                      >
                        <Show
                          when={rt.running}
                          fallback={
                            <Button
                              size="small"
                              variant="primary"
                              class="settings-panel-action"
                              disabled={busy() || !!starting()}
                              onClick={() => startRuntime(rt)}
                            >
                              {starting() === rt.id
                                ? language.t("settings.copy.starting")
                                : language.t("settings.copy.start")}
                            </Button>
                          }
                        >
                          <Button
                            size="small"
                            variant="primary"
                            class="settings-panel-action"
                            disabled={busy() || rt.models.length === 0}
                            onClick={() => choose(rt)}
                          >
                            {language.t("settings.copy.chooseModels")}
                          </Button>
                        </Show>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Card>
        </Section>

        {/* ── Pull a model (Ollama) ── */}
        <Section
          title={language.t("settings.copy.pullAModel")}
          description={language.t("settings.copy.copyAnOllamaPullCommandThenRunIt")}
        >
          <Card>
            <div class="settings-row">
              <RowCopy
                title={language.t("settings.copy.pullAModel")}
                description={language.t("settings.copy.typeANameFromTheOllamaLibrarySuch")}
              />
              <div class="ml-auto flex max-w-full shrink-0 items-center gap-2">
                <input
                  class="settings-field w-44 min-w-0"
                  aria-label={language.t("settings.copy.modelToPullWithOllama")}
                  placeholder="llama3.1"
                  value={pullName()}
                  onInput={(e) => setPullName(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && pull()}
                />
                <Button
                  size="small"
                  variant="secondary"
                  class="settings-panel-action shrink-0"
                  disabled={!pullName().trim()}
                  onClick={pull}
                >
                  {language.t("settings.copy.copyCommand")}
                </Button>
              </div>
            </div>
            <div class="settings-row">
              <RowCopy
                title={language.t("settings.copy.startOllama")}
                description={language.t("settings.copy.copiesOllamaServeRunItFirstIfThe")}
              />
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action ml-auto shrink-0"
                aria-label={language.t("settings.copy.copyOllamaServeCommand")}
                onClick={() => void copyCommand("ollama serve")}
              >
                {language.t("settings.copy.copyCommand")}
              </Button>
            </div>
          </Card>
        </Section>

        {/* ── Detected runtimes ── */}
        <Section
          title={language.t("settings.copy.detectedOnThisMachine")}
          description={language.t("settings.copy.serversAlreadyRunningHereThatOpenscienceCanUse")}
        >
          <Card>
            <div class="settings-row">
              <RowCopy
                title={language.t("settings.copy.scanForServers")}
                description={language.t("settings.copy.looksForOllamaLmStudioAndOtherOpenai")}
              />
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action ml-auto shrink-0"
                disabled={busy()}
                onClick={refetch}
              >
                {language.t("settings.copy.rescan")}
              </Button>
            </div>
            <Show
              when={!detected.loading && !status.loading}
              fallback={
                <div
                  class="settings-panel-loading__rows"
                  role="status"
                  aria-label={language.t("settings.copy.scanningForLocalServers")}
                >
                  <span />
                  <span />
                </div>
              }
            >
              <For
                each={discoveries()}
                fallback={
                  <p class="settings-card-empty" role="status">
                    {language.t("settings.copy.nothingRunningYetStartAServerSuchAs")}
                  </p>
                }
              >
                {(d) => (
                  <div class="settings-row">
                    <RowCopy title={d.name} description={`${d.baseURL} · ${d.models.length} model(s)`} />
                    <Button
                      size="small"
                      variant="primary"
                      class="settings-panel-action ml-auto shrink-0"
                      disabled={busy()}
                      onClick={() => choose(d)}
                    >
                      {language.t("settings.copy.chooseModels")}
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </Card>
        </Section>

        <Show when={choice()}>
          {(source) => (
            <Section
              title={`Choose ${source().name} models`}
              description={language.t("settings.copy.onlyTheModelsYouSelectAppearInModels")}
            >
              <div class="settings-card settings-form-card" aria-label={`Choose ${source().name} models`}>
                <div class="flex items-center justify-between gap-2">
                  <span class="text-12-regular text-text-weak">
                    {chosen().size} {language.t("settings.copy.of")}
                    {source().models.length} {language.t("settings.copy.selected")}
                  </span>
                  <div class="flex items-center gap-2">
                    <Button
                      size="small"
                      variant="ghost"
                      class="settings-panel-action settings-panel-action--quiet"
                      disabled={chosen().size === source().models.length}
                      onClick={() => setChosen(new Set(source().models))}
                    >
                      {language.t("settings.copy.selectAll")}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      class="settings-panel-action settings-panel-action--quiet"
                      disabled={chosen().size === 0}
                      onClick={() => setChosen(new Set<string>())}
                    >
                      {language.t("dialog.server.default.clear")}
                    </Button>
                  </div>
                </div>
                <div class="flex max-h-52 flex-col gap-1 overflow-y-auto">
                  <For each={source().models}>
                    {(model) => (
                      <Checkbox checked={chosen().has(model)} onChange={() => toggleChoice(model)}>
                        <span class="min-w-0 truncate text-12-regular">{model}</span>
                      </Checkbox>
                    )}
                  </For>
                </div>
                <ContextField
                  value={context()}
                  onInput={setContext}
                  description={
                    isOllama(source().id, source().baseURL)
                      ? language.t("settings.copy.appliedToTheSelectedModelsAsATuned")
                      : language.t("settings.copy.howMuchContextOpenscienceMaySendToThese")
                  }
                />
                <div class="flex justify-end gap-2">
                  <Button
                    size="small"
                    variant="secondary"
                    class="settings-panel-action"
                    disabled={busy()}
                    onClick={() => setChoice(undefined)}
                  >
                    {language.t("common.cancel")}
                  </Button>
                  <Button
                    size="small"
                    variant="primary"
                    class="settings-panel-action"
                    disabled={busy() || chosen().size === 0}
                    onClick={addChoice}
                  >
                    {language.t("settings.copy.add")}
                    {chosen().size} {language.t("settings.copy.selected")}
                  </Button>
                </div>
              </div>
            </Section>
          )}
        </Show>

        <Section
          title={language.t("settings.copy.connectOverSsh")}
          description={language.t("settings.copy.openAnEncryptedLocalForwardToAModel")}
        >
          <Card>
            <div class="settings-row">
              <RowCopy
                title={language.t("settings.copy.remoteGpuOverSsh")}
                description={language.t("settings.copy.tunnelAModelServerOnAHostFrom")}
              />
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action ml-auto shrink-0"
                aria-expanded={sshOpen()}
                onClick={() => setSshOpen((value) => !value)}
              >
                {sshOpen() ? language.t("common.cancel") : language.t("settings.copy.connect")}
              </Button>
            </div>
          </Card>
          <Show when={sshOpen()}>
            <div class="settings-card settings-form-card">
              <div class="settings-form-grid">
                <Field
                  label={language.t("settings.copy.sshHost")}
                  span="full"
                  placeholder="research-gpu or user@gpu.example.org"
                  value={sshHost()}
                  onInput={setSshHost}
                />
                <Field
                  label={language.t("settings.copy.remoteModelPort")}
                  type="number"
                  min="1"
                  max="65535"
                  placeholder="11434"
                  value={sshRemotePort()}
                  onInput={setSshRemotePort}
                />
                <Field
                  label={language.t("settings.copy.localTunnelPort")}
                  type="number"
                  min="1024"
                  max="65535"
                  placeholder="12434"
                  value={sshLocalPort()}
                  onInput={setSshLocalPort}
                />
                <Field
                  label={language.t("settings.copy.endpointKeyOptional")}
                  span="full"
                  type="password"
                  placeholder={language.t("settings.copy.onlyIfTheRemoteModelServerRequiresOne")}
                  value={sshKey()}
                  onInput={setSshKey}
                />
              </div>
              <ContextField
                value={context()}
                onInput={setContext}
                description={language.t("settings.copy.howMuchContextOpenscienceMaySendToThe")}
              />
              <div class="flex justify-end">
                <Button
                  size="small"
                  variant="primary"
                  class="settings-panel-action"
                  disabled={busy() || !sshHost().trim()}
                  onClick={connectSSH}
                >
                  {language.t("settings.copy.connectModels")}
                </Button>
              </div>
            </div>
          </Show>
        </Section>

        {/* ── Custom endpoint ── */}
        <Section
          title={language.t("settings.copy.directEndpoint")}
          description={language.t("settings.copy.connectALocalLanVpnOrHttpsOpenai")}
        >
          <Card>
            <div class="settings-row">
              <RowCopy
                title={language.t("settings.copy.openaiCompatibleEndpoint")}
                description={language.t("settings.copy.aUrlOnThisMachineYourLanOr")}
              />
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action ml-auto shrink-0"
                aria-expanded={directOpen()}
                onClick={() => setDirectOpen((value) => !value)}
              >
                {directOpen() ? language.t("common.cancel") : language.t("settings.copy.connect")}
              </Button>
            </div>
          </Card>
          <Show when={directOpen()}>
            <div class="settings-card settings-form-card">
              <div class="settings-form-grid">
                <Field
                  label={language.t("settings.copy.endpointUrl")}
                  span="full"
                  inputMode="url"
                  placeholder="http://localhost:11434/v1"
                  value={url()}
                  onInput={setUrl}
                />
                <Field
                  label={language.t("settings.copy.apiKeyOptional")}
                  span="full"
                  type="password"
                  placeholder={language.t("settings.copy.mostLocalServersNeedNone")}
                  value={key()}
                  onInput={setKey}
                />
              </div>
              <div class="flex flex-wrap justify-end gap-2">
                <Button
                  size="small"
                  variant="secondary"
                  class="settings-panel-action"
                  disabled={busy() || !url().trim()}
                  onClick={listCustom}
                >
                  {language.t("settings.copy.listModels")}
                </Button>
                <Show when={found().length > 0}>
                  <Button
                    size="small"
                    variant="primary"
                    class="settings-panel-action"
                    disabled={busy() || selected().size === 0}
                    onClick={addCustom}
                  >
                    {language.t("settings.copy.add")}
                    {selected().size} {language.t("settings.copy.selected")}
                  </Button>
                </Show>
              </div>
              <Show when={found().length > 0}>
                <div class="flex flex-col gap-1">
                  <span class="text-12-regular text-text-weak">{listedUrl()}</span>
                  <For each={found()}>
                    {(m) => (
                      <Checkbox checked={selected().has(m)} onChange={() => toggle(m)}>
                        <span class="min-w-0 truncate text-12-regular">{m}</span>
                      </Checkbox>
                    )}
                  </For>
                </div>
                <ContextField
                  value={context()}
                  onInput={setContext}
                  description={
                    isOllama(undefined, listedUrl())
                      ? language.t("settings.copy.appliedToTheSelectedModelsAsATuned2")
                      : language.t("settings.copy.howMuchContextOpenscienceMaySendToThese")
                  }
                />
              </Show>
            </div>
          </Show>
        </Section>

        {/* ── Configured ── */}
        <Section
          title={language.t("settings.copy.configured")}
          description={
            configured()?.length
              ? `${configured()?.length} local or self-hosted provider${configured()?.length === 1 ? "" : "s"} in the catalog.`
              : language.t("settings.copy.localAndSelfHostedProvidersYouHaveAdded")
          }
        >
          <Card>
            <Show
              when={!configured.loading}
              fallback={
                <div
                  class="settings-panel-loading__rows"
                  role="status"
                  aria-label={language.t("settings.copy.loadingConfiguredProviders")}
                >
                  <span />
                </div>
              }
            >
              <For
                each={configured()}
                fallback={
                  <p class="settings-card-empty" role="status">
                    {language.t("settings.copy.noLocalOrSelfHostedProvidersYet")}
                  </p>
                }
              >
                {(p) => (
                  <div class="settings-row">
                    <RowCopy
                      title={p.id}
                      description={`${p.baseURL} · ${p.models.length} model(s)${p.runtime?.startsWith("ssh:") ? " · SSH tunnel" : ""}`}
                    />
                    <Button
                      size="small"
                      variant="ghost"
                      icon="trash"
                      class="settings-panel-action settings-panel-action--danger-quiet ml-auto shrink-0"
                      disabled={busy()}
                      onClick={() => removeProvider(p.id)}
                    >
                      {language.t("settings.providerKeys.remove")}
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </Card>
        </Section>
      </PanelBody>
    </PanelScroll>
  )
}

export default LocalModels

const Field: Component<{
  label: string
  value: string
  placeholder: string
  onInput: (value: string) => void
  span?: "full"
  type?: JSX.InputHTMLAttributes<HTMLInputElement>["type"]
  inputMode?: JSX.InputHTMLAttributes<HTMLInputElement>["inputMode"]
  min?: string
  max?: string
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1.5" data-span={props.span}>
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <input
      class="settings-field"
      type={props.type}
      inputMode={props.inputMode}
      min={props.min}
      max={props.max}
      autocomplete={props.type === "password" ? "off" : undefined}
      value={props.value}
      placeholder={props.placeholder}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)

// Every local endpoint records a context window; without one, OpenScience
// assumes 32k and compacts long research sessions far too early on servers
// that allow much more.
const ContextField: Component<{ value: string; description: string; onInput: (value: string) => void }> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-row">
      <RowCopy title={language.t("settings.copy.contextWindow")} description={props.description} />
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <input
          class="settings-field w-32 text-right"
          type="number"
          min="1024"
          max="2097152"
          step="1024"
          aria-label={language.t("settings.copy.contextWindowInTokens")}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
        <span class="text-12-regular text-text-weak">{language.t("settings.copy.tokens")}</span>
      </div>
    </div>
  )
}
