import { useLanguage } from "@/context/language"
import { For, Show, createEffect, createResource, type Component, type JSX, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { confirmDialog } from "@/atlas/dialogs"
import { settingsApi } from "./api"
import { CredentialServices } from "./CredentialServices"
import { Card, PanelBody, PanelHeader, PanelScroll, RowCopy, Section, steady } from "./_shared"
import "./preference-panels.css"
import { ProviderLogo } from "./ProviderLogo"

type Scheduler = "none" | "slurm" | "pbs"
type Host = {
  id: string
  label: string
  host: string
  user?: string
  port?: number
  identity_file?: string
  proxy_jump?: string
  scheduler: Scheduler
  workdir?: string
  notes?: string
  fingerprint?: string
  concurrency: number
}
type Provider = {
  id: string
  name: string
  integration: "integrated" | "cli_credential"
  placeholder: string
  hint: string
  credential: {
    label: string
    environment: string
    aliases: string[]
    docs_url: string
  }
  connected: boolean
  enabled: boolean
  source: "stored" | "modal_toml" | null
  connected_at: string | null
  last_used: string | null
}
type ConfigHost = {
  alias: string
  hostname?: string
  user?: string
  port?: number
  identity_file?: string
  proxy_jump?: string
}
type Modal = {
  app: string
  image: string
  network: "unrestricted" | "none"
  timeout_minutes: number
  concurrency: number
}
type Info = {
  providers: Provider[]
  ssh_hosts: Host[]
  ssh_config_hosts: ConfigHost[]
  modal: Modal
  modal_file: { found: boolean; ready: boolean }
  environments: {
    status: "absent" | "installing" | "ready" | "failed"
    phase: string
    error?: string
    environments: { language: "python" | "r"; ready: boolean; path: string; packages: string[] }[]
  }
}
type Probe = {
  ok: boolean
  host: string
  latency_ms: number
  hostname?: string
  python: boolean
  gpu: boolean
  slurm: boolean
  pbs: boolean
  fingerprint?: string
  error?: string
}
type Notice = {
  tone: "neutral" | "success" | "error"
  title: string
  detail?: string
}
type ProviderDoctor = {
  ok: boolean
  provider: string
  cli: string
  command: string
  checked_at: string
  error?: string
}

const schedulers = [
  { value: "none" as const, label: "Plain SSH" },
  { value: "slurm" as const, label: "Slurm" },
  { value: "pbs" as const, label: "PBS" },
]

const Compute: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const fetchFn = platform.fetch ?? fetch
  const call = <T,>(path = "", init?: RequestInit) => settingsApi<T>(sdk.url, fetchFn, `/settings/compute${path}`, init)
  const [data, control] = steady(createResource(() => call<Info>()))
  const [state, setState] = createStore({
    adding: false,
    busy: {} as Record<string, boolean>,
    probes: {} as Record<string, Probe>,
    label: "",
    host: "",
    user: "",
    port: "",
    identityFile: "",
    proxyJump: "",
    scheduler: "none" as Scheduler,
    workdir: "",
    notes: "",
    sshConcurrency: "4",
    editingHost: undefined as string | undefined,
    notesDraft: "",
    token: "",
    secret: "",
    app: "",
    image: "",
    network: "none" as Modal["network"],
    timeout: "60",
    concurrency: "10",
    connection: undefined as Notice | undefined,
    defaults: undefined as Notice | undefined,
    providerKeys: {} as Record<string, string>,
    providerChecks: {} as Record<string, ProviderDoctor>,
    editingProvider: undefined as string | undefined,
  })
  const adding = () => state.adding
  const setAdding: Setter<boolean> = (value) => setState("adding", value)
  const setBusy = (key: string, value: boolean) => {
    setState("busy", (current) => {
      const next = { ...current }
      if (value) next[key] = true
      else delete next[key]
      return next
    })
    return value
  }
  const isBusy = (key: string) => Boolean(state.busy[key])
  const hasBusyPrefix = (prefix: string) => Object.keys(state.busy).some((key) => key.startsWith(prefix))
  const modalBusy = () => hasBusyPrefix("modal:")
  const sshMutationBusy = () =>
    isBusy("ssh:add") || hasBusyPrefix("ssh:remove:") || hasBusyPrefix("ssh:update:") || hasBusyPrefix("ssh:import:")
  const hostBusy = (id: string) => isBusy(`ssh:test:${id}`) || isBusy(`ssh:remove:${id}`) || isBusy(`ssh:update:${id}`)
  const probes = () => state.probes
  const setProbes: Setter<Record<string, Probe>> = (value) => setState("probes", value)
  const label = () => state.label
  const setLabel: Setter<string> = (value) => setState("label", value)
  const host = () => state.host
  const setHost: Setter<string> = (value) => setState("host", value)
  const user = () => state.user
  const setUser: Setter<string> = (value) => setState("user", value)
  const port = () => state.port
  const setPort: Setter<string> = (value) => setState("port", value)
  const identityFile = () => state.identityFile
  const setIdentityFile: Setter<string> = (value) => setState("identityFile", value)
  const proxyJump = () => state.proxyJump
  const setProxyJump: Setter<string> = (value) => setState("proxyJump", value)
  const scheduler = () => state.scheduler
  const setScheduler: Setter<Scheduler> = (value) => setState("scheduler", value)
  const workdir = () => state.workdir
  const setWorkdir: Setter<string> = (value) => setState("workdir", value)
  const notes = () => state.notes
  const setNotes: Setter<string> = (value) => setState("notes", value)
  const sshConcurrency = () => state.sshConcurrency
  const setSshConcurrency: Setter<string> = (value) => setState("sshConcurrency", value)
  const editingHost = () => state.editingHost
  const notesDraft = () => state.notesDraft
  const setNotesDraft: Setter<string> = (value) => setState("notesDraft", value)
  const token = () => state.token
  const setToken: Setter<string> = (value) => setState("token", value)
  const secret = () => state.secret
  const setSecret: Setter<string> = (value) => setState("secret", value)
  const app = () => state.app
  const setApp: Setter<string> = (value) => setState("app", value)
  const image = () => state.image
  const setImage: Setter<string> = (value) => setState("image", value)
  const network = () => state.network
  const setNetwork: Setter<Modal["network"]> = (value) => setState("network", value)
  const timeout = () => state.timeout
  const setTimeout: Setter<string> = (value) => setState("timeout", value)
  const concurrency = () => state.concurrency
  const setConcurrency: Setter<string> = (value) => setState("concurrency", value)
  const connection = () => state.connection
  const setConnection = (value: Notice | undefined) => {
    setState("connection", value)
    return value
  }
  const defaults = () => state.defaults
  const setDefaults = (value: Notice | undefined) => {
    setState("defaults", value)
    return value
  }
  const modal = () => data()?.providers.find((item) => item.id === "modal")
  const cliProviders = () => data()?.providers.filter((item) => item.integration === "cli_credential") ?? []
  const providerKey = (id: string) => state.providerKeys[id] ?? ""
  const setProviderKey = (id: string, value: string) => setState("providerKeys", id, value)
  const editingProvider = () => state.editingProvider
  const providerCheck = (id: string) => state.providerChecks[id]
  const environment = (language: "python" | "r") =>
    data()?.environments.environments.find((item) => item.language === language)
  const configHosts = () => {
    const saved = new Set(data()?.ssh_hosts.flatMap((item) => [item.label, item.host]) ?? [])
    return (
      data()?.ssh_config_hosts.filter((item) => !saved.has(item.alias) && !saved.has(item.hostname ?? item.alias)) ?? []
    )
  }
  const dirty = () => {
    const value = data()?.modal
    if (!value) return false
    return (
      app().trim() !== value.app ||
      image().trim() !== value.image ||
      network() !== value.network ||
      timeout().trim() !== String(value.timeout_minutes) ||
      concurrency().trim() !== String(value.concurrency)
    )
  }
  const connectionNotice = (): Notice | undefined => {
    return connection()
  }
  const defaultsNotice = (): Notice | undefined => {
    if (!modal()?.connected) return undefined
    const current = defaults()
    if (current?.tone === "error" || isBusy("modal:save")) return current
    if (dirty()) {
      return {
        tone: "neutral",
        title: language.t("settings.copy.unsavedDefaultChanges"),
        detail: language.t("settings.copy.saveDefaultsBeforeReviewingANewModalJob"),
      }
    }
    return current
  }

  let modalHydrated = false
  createEffect(() => {
    const value = data()?.modal
    if (!value) return
    // Refreshes from connection/toggle calls must not erase edits the user is
    // still making in the defaults form.
    if (modalHydrated && dirty()) return
    setApp(value.app)
    setImage(value.image)
    setNetwork(value.network)
    setTimeout(String(value.timeout_minutes))
    setConcurrency(String(value.concurrency))
    modalHydrated = true
  })

  const connect = async () => {
    setBusy("modal:connect", true)
    setConnection({ tone: "neutral", title: language.t("settings.copy.savingModalToken") })
    const next = await call<Info>("/provider/modal", {
      method: "POST",
      body: JSON.stringify({ key: `${token().trim()} : ${secret().trim()}` }),
    }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: language.t("settings.copy.couldNotSaveModalToken"), detail })
      showToast({ title: language.t("settings.copy.couldNotSaveModalToken"), description: detail })
      return undefined
    })
    setBusy("modal:connect", false)
    if (!next) return
    control.mutate(next)
    setToken("")
    setSecret("")
    setConnection({
      tone: "success",
      title: language.t("settings.copy.modalTokenSaved"),
      detail: language.t("settings.copy.enableModalThenTestTheConnectionBeforeDispatching"),
    })
    showToast({
      variant: "success",
      title: language.t("settings.copy.modalTokenSaved"),
      description: language.t("settings.copy.enableModalBeforeTestingOrRunning"),
    })
  }

  const configure = async () => {
    setBusy("modal:configure", true)
    setConnection({
      tone: "neutral",
      title: language.t("settings.copy.configuringModal"),
      detail: language.t("settings.copy.readingTheActiveModalTomlProfile"),
    })
    const next = await call<Info>("/modal/configure", { method: "POST" }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: language.t("settings.copy.couldNotConfigureModal"), detail })
      showToast({ title: language.t("settings.copy.couldNotConfigureModal"), description: detail })
      return undefined
    })
    setBusy("modal:configure", false)
    if (!next) return
    control.mutate(next)
    setConnection({
      tone: "success",
      title: language.t("settings.copy.modalConfiguredAndEnabled"),
      detail: language.t("settings.copy.theProfileIsSavedTestTheConnectionTo"),
    })
    showToast({
      variant: "success",
      title: language.t("settings.copy.modalConfiguredAndEnabled"),
      description: language.t("settings.copy.openscienceWillUseTheActiveProfileInModal"),
    })
  }

  const toggle = async (enabled: boolean) => {
    setBusy("modal:toggle", true)
    setConnection({
      tone: "neutral",
      title: enabled ? language.t("settings.copy.enablingModal") : language.t("settings.copy.disablingModal"),
    })
    const next = await call<Info>("/provider/modal/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: language.t("settings.copy.couldNotUpdateModal"), detail })
      showToast({ title: language.t("settings.copy.couldNotUpdateModal"), description: detail })
      return undefined
    })
    setBusy("modal:toggle", false)
    if (!next) return
    control.mutate(next)
    setConnection({
      tone: "success",
      title: enabled ? language.t("settings.copy.modalEnabled") : language.t("settings.copy.modalDisabled"),
      detail: enabled
        ? language.t("settings.copy.connectionNotTestedSinceEnablingSelectTestConnection")
        : language.t("settings.copy.credentialResolutionAndNewModalDispatchesAreBlocked"),
    })
  }

  const check = async () => {
    setBusy("modal:check", true)
    setConnection({
      tone: "neutral",
      title: language.t("settings.copy.checkingModalConnection"),
      detail: language.t("settings.copy.verifyingTheConfiguredProfile"),
    })
    const result = await call<{ ok: true; sdk: string }>("/modal/check", { method: "POST" }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: language.t("settings.copy.connectionCheckFailed"), detail })
      showToast({ title: language.t("settings.copy.modalConnectionFailed"), description: detail })
      return undefined
    })
    setBusy("modal:check", false)
    if (!result) return
    setConnection({
      tone: "success",
      title: language.t("settings.copy.connectionVerified"),
      detail: `Modal accepted this profile using SDK ${result.sdk}.`,
    })
    showToast({
      variant: "success",
      title: language.t("settings.copy.modalIsReady"),
      description: `Connected with Modal SDK ${result.sdk}.`,
    })
  }

  const saveModal = async () => {
    const minutes = Number(timeout())
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
      setDefaults({
        tone: "error",
        title: language.t("settings.copy.defaultsNotSaved"),
        detail: language.t("settings.copy.useAWholeNumberTimeoutFrom1To"),
      })
      showToast({
        title: language.t("settings.copy.invalidModalTimeout"),
        description: language.t("settings.copy.useAWholeNumberFrom1To1440"),
      })
      return
    }
    const limit = Number(concurrency())
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      setDefaults({
        tone: "error",
        title: language.t("settings.copy.defaultsNotSaved"),
        detail: language.t("settings.copy.useAWholeNumberConcurrentJobLimitFrom"),
      })
      showToast({
        title: language.t("settings.copy.invalidModalConcurrency"),
        description: language.t("settings.copy.useAWholeNumberFrom1To100"),
      })
      return
    }
    setBusy("modal:save", true)
    setDefaults({ tone: "neutral", title: language.t("settings.copy.savingModalDefaults") })
    const next = await call<Info>("/modal", {
      method: "PATCH",
      body: JSON.stringify({
        app: app().trim(),
        image: image().trim(),
        network: network(),
        timeout_minutes: minutes,
        concurrency: limit,
      }),
    }).catch((error) => {
      const detail = message(error)
      setDefaults({ tone: "error", title: language.t("settings.copy.defaultsNotSaved"), detail })
      showToast({ title: language.t("settings.copy.couldNotSaveModalDefaults"), description: detail })
      return undefined
    })
    setBusy("modal:save", false)
    if (!next) return
    control.mutate(next)
    setDefaults({
      tone: "success",
      title: language.t("settings.copy.defaultsSaved"),
      detail: language.t("settings.copy.newModalJobReviewsWillUseTheseValues"),
    })
    showToast({ variant: "success", title: language.t("settings.copy.modalDefaultsSaved") })
  }

  const repairEnvironments = async () => {
    setBusy("environments:repair", true)
    const next = await call<Info>("/environments/repair", { method: "POST" }).catch(async (error) => {
      showToast({ title: language.t("settings.copy.environmentSetupFailed"), description: message(error) })
      // The card reads the recorded failure; refresh so it names the reason.
      await control.refetch()
      return undefined
    })
    setBusy("environments:repair", false)
    if (!next) return
    control.mutate(next)
    showToast({ variant: "success", title: language.t("settings.copy.scientificEnvironmentsAreReady") })
  }

  const saveProvider = async (item: Provider) => {
    const key = `provider:save:${item.id}`
    const value = providerKey(item.id).trim()
    if (!value || isBusy(key)) return
    setBusy(key, true)
    const next = await call<Info>(`/provider/${item.id}`, {
      method: "POST",
      body: JSON.stringify({ key: value }),
    }).catch((error) => {
      showToast({ title: `Could not save ${item.name} credential`, description: message(error) })
      return undefined
    })
    setBusy(key, false)
    if (!next) return
    control.mutate(next)
    setProviderKey(item.id, "")
    setState("editingProvider", undefined)
    const saved = next.providers.find((provider) => provider.id === item.id)
    showToast({
      variant: "success",
      title: `${item.name} credential saved`,
      description: saved?.enabled
        ? language.t("settings.copy.enabledTestConnectionMustApproveAnAdministratorManaged")
        : language.t("settings.copy.savedEncryptedAndOffGenericAgentProcessesCannot"),
    })
  }

  const toggleProvider = async (item: Provider, enabled: boolean) => {
    const key = `provider:toggle:${item.id}`
    if (isBusy(key)) return
    setBusy(key, true)
    const next = await call<Info>(`/provider/${item.id}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }).catch((error) => {
      showToast({ title: `Could not ${enabled ? "enable" : "disable"} ${item.name}`, description: message(error) })
      return undefined
    })
    setBusy(key, false)
    if (!next) return
    control.mutate(next)
    showToast({
      variant: "success",
      title: enabled ? `${item.name} credential enabled` : `${item.name} credential is off`,
      description: enabled
        ? language.t("settings.copy.aReviewedProviderSpecificBrokerMayResolveIt")
        : language.t("settings.copy.providerSpecificBrokersCannotResolveThisCredential"),
    })
  }

  const checkProvider = async (item: Provider) => {
    const key = `provider:check:${item.id}`
    if (isBusy(key) || !item.enabled) return
    setBusy(key, true)
    setState("providerChecks", item.id, {
      ok: false,
      provider: item.id,
      cli: "",
      command: "",
      checked_at: new Date().toISOString(),
    })
    const result = await call<ProviderDoctor>(`/provider/${item.id}/doctor`, { method: "POST" }).catch((error) => ({
      ok: false,
      provider: item.id,
      cli: "",
      command: "",
      checked_at: new Date().toISOString(),
      error: message(error),
    }))
    setBusy(key, false)
    setState("providerChecks", item.id, result)
    if (result.ok) await control.refetch()
    showToast({
      variant: result.ok ? "success" : "error",
      title: result.ok ? `${item.name} connection verified` : `${item.name} connection failed`,
      description: result.ok ? `${result.command} completed successfully.` : result.error,
    })
  }

  const removeProvider = async (item: Provider) => {
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${item.name} credential?`,
      message: language.t("settings.copy.thisRemovesTheEncryptedCredentialItDoesNot"),
      confirmLabel: language.t("settings.copy.removeCredential"),
      danger: true,
    })
    if (!confirmed) return
    const key = `provider:remove:${item.id}`
    setBusy(key, true)
    const next = await call<Info>(`/provider/${item.id}`, { method: "DELETE" }).catch((error) => {
      showToast({ title: `Could not remove ${item.name} credential`, description: message(error) })
      return undefined
    })
    setBusy(key, false)
    if (!next) return
    control.mutate(next)
    setProviderKey(item.id, "")
    if (editingProvider() === item.id) setState("editingProvider", undefined)
  }

  const reset = () => {
    setLabel("")
    setHost("")
    setUser("")
    setPort("")
    setIdentityFile("")
    setProxyJump("")
    setScheduler("none")
    setWorkdir("")
    setNotes("")
    setSshConcurrency("4")
    setAdding(false)
  }

  const add = async () => {
    const parsedPort = port().trim() ? Number(port()) : undefined
    if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)) {
      showToast({
        title: language.t("settings.copy.invalidSshPort"),
        description: language.t("settings.copy.useAPortBetween1And65535"),
      })
      return
    }
    const limit = Number(sshConcurrency())
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      showToast({
        title: language.t("settings.copy.invalidSshConcurrency"),
        description: language.t("settings.copy.useAWholeNumberFrom1To100"),
      })
      return
    }
    setBusy("ssh:add", true)
    const next = await call<Info>("/ssh", {
      method: "POST",
      body: JSON.stringify({
        label: label().trim(),
        host: host().trim(),
        user: user().trim() || undefined,
        port: parsedPort,
        identity_file: identityFile().trim() || undefined,
        proxy_jump: proxyJump().trim() || undefined,
        scheduler: scheduler(),
        workdir: workdir().trim() || undefined,
        notes: notes().trim() || undefined,
        concurrency: limit,
      }),
    }).catch((error) => {
      showToast({ title: language.t("settings.copy.couldNotAddSshHost"), description: message(error) })
      return undefined
    })
    setBusy("ssh:add", false)
    if (!next) return
    control.mutate(next)
    reset()
    showToast({
      variant: "success",
      title: language.t("settings.copy.sshHostAdded"),
      description: language.t("settings.copy.testTheConnectionBeforeDispatch"),
    })
  }

  const test = async (item: Host) => {
    const busyKey = `ssh:test:${item.id}`
    setBusy(busyKey, true)
    const result = await call<Probe>(`/ssh/${item.id}/test`, { method: "POST" }).catch((error) => ({
      ok: false,
      host: item.label,
      latency_ms: 0,
      python: false,
      gpu: false,
      slurm: false,
      pbs: false,
      error: message(error),
    }))
    setProbes((current) => ({ ...current, [item.id]: result }))
    setBusy(busyKey, false)
    showToast({
      variant: result.ok ? "success" : "error",
      title: result.ok ? `${item.label} is reachable` : `Could not reach ${item.label}`,
      description: result.ok ? `${result.latency_ms} ms · ${capabilities(result)}` : result.error,
    })
  }

  const importHost = async (item: ConfigHost) => {
    const busyKey = `ssh:import:${item.alias}`
    setBusy(busyKey, true)
    const next = await call<Info>("/ssh", {
      method: "POST",
      body: JSON.stringify({
        label: item.alias,
        host: item.hostname ?? item.alias,
        user: item.user,
        port: item.port,
        identity_file: item.identity_file,
        proxy_jump: item.proxy_jump,
        scheduler: "none",
        concurrency: 4,
      }),
    }).catch((error) => {
      showToast({ title: language.t("settings.copy.couldNotImportSshHost"), description: message(error) })
      return undefined
    })
    setBusy(busyKey, false)
    if (!next) return
    control.mutate(next)
    showToast({
      variant: "success",
      title: `${item.alias} imported`,
      description: language.t("settings.copy.testItToPinTheHostKey"),
    })
  }

  const beginNotes = (item: Host) => {
    setState("editingHost", item.id)
    setNotesDraft(item.notes ?? "")
  }

  const cancelNotes = () => {
    setState("editingHost", undefined)
    setNotesDraft("")
  }

  const saveNotes = async (item: Host) => {
    const busyKey = `ssh:update:${item.id}`
    setBusy(busyKey, true)
    const next = await call<Info>(`/ssh/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notes: notesDraft().trim() }),
    }).catch((error) => {
      showToast({ title: language.t("settings.copy.couldNotSaveHostNotes"), description: message(error) })
      return undefined
    })
    setBusy(busyKey, false)
    if (!next) return
    control.mutate(next)
    cancelNotes()
    showToast({ variant: "success", title: language.t("settings.copy.hostNotesSaved") })
  }

  const remove = async (item: Host) => {
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${item.label}?`,
      message: language.t("settings.copy.thisRemovesTheSavedConnectionProfileItDoes"),
      confirmLabel: language.t("settings.copy.removeHost"),
      danger: true,
    })
    if (!confirmed) return
    const busyKey = `ssh:remove:${item.id}`
    setBusy(busyKey, true)
    const next = await call<Info>(`/ssh/${item.id}`, { method: "DELETE" }).catch((error) => {
      showToast({ title: language.t("settings.copy.couldNotRemoveSshHost"), description: message(error) })
      return undefined
    })
    setBusy(busyKey, false)
    if (!next) return
    control.mutate(next)
    setProbes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id)))
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--compute">
        <PanelHeader
          title={language.t("settings.shell.panel.compute")}
          description={language.t("settings.copy.chooseWhereAgentManagedPythonRShellAnd")}
        />
        <PanelBody>
          <Section
            title={language.t("settings.copy.localRuntimes")}
            description={language.t("settings.copy.openscienceOwnsSharedReproducibleStarterEnvironmentsAndKeeps")}
          >
            <Card>
              <div class="settings-row settings-compute-summary-row">
                <RowCopy
                  title={language.t("settings.copy.pythonStarter")}
                  description={language.t("settings.copy.python311WithNumpyPandasScipyMatplotlib")}
                />
                <div class="settings-compute-summary-action">
                  <Badge tone={environment("python")?.ready ? "ready" : "muted"}>
                    {environment("python")?.ready
                      ? language.t("settings.copy.ready")
                      : language.t("settings.copy.setupNeeded")}
                  </Badge>
                </div>
              </div>
              <div class="settings-row settings-compute-summary-row">
                <RowCopy
                  title={language.t("settings.copy.rStarter")}
                  description={language.t("settings.copy.rWithTidyverseGgplot2AndJsonliteItIs")}
                />
                <div class="settings-compute-summary-action">
                  <Badge tone={environment("r")?.ready ? "ready" : "muted"}>
                    {environment("r")?.ready
                      ? language.t("settings.copy.ready")
                      : language.t("settings.copy.setupNeeded")}
                  </Badge>
                </div>
              </div>
              <Show when={data()?.environments.status !== "ready"}>
                <div class="settings-row items-center gap-3">
                  <div class="settings-list-copy min-w-0 flex-1">
                    <strong>
                      {data()?.environments.status === "failed"
                        ? language.t("settings.copy.starterSetupNeedsAttention")
                        : language.t("settings.copy.preparingEnvironments")}
                    </strong>
                    <span>
                      {data()?.environments.error ??
                        language.t("settings.copy.firstSetupDownloadsMicromambaAndCreatesThePython")}
                    </span>
                  </div>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={isBusy("environments:repair")}
                    onClick={() => void repairEnvironments()}
                  >
                    {isBusy("environments:repair")
                      ? language.t("settings.copy.preparing")
                      : language.t("settings.copy.setUpOrRepair")}
                  </Button>
                </div>
              </Show>
            </Card>
          </Section>

          <Section title="Modal" description={language.t("settings.copy.connectModalForApprovedJobsInIsolatedCloud")}>
            <Card>
              <div class="settings-compute-card" aria-busy={modalBusy() ? "true" : undefined}>
                <div class="settings-compute-provider-row">
                  <span class="settings-row-logo" aria-hidden="true">
                    <ProviderLogo id="modal" label="Modal" size="small" />
                  </span>
                  <div class="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
                    <span class="text-14-medium text-text-strong">Modal</span>
                    <span class="text-12-regular text-text-weak">
                      {modal()?.connected
                        ? modal()?.source === "modal_toml"
                          ? language.t("settings.copy.activeProfileFromModalToml")
                          : language.t("settings.copy.tokenStoredLocallyAndEncrypted")
                        : data()?.modal_file.ready
                          ? language.t("settings.copy.modalCliConfigurationFoundAtModalTomlToken")
                          : data()?.modal_file.found
                            ? language.t("settings.copy.modalConfigFoundButItsActiveProfileHas")
                            : language.t("settings.copy.enterTheTokenIdAndSecretFromModal")}
                    </span>
                  </div>
                  <Show when={modal()?.connected}>
                    <div class="settings-compute-actions">
                      <span class="settings-row-status">
                        {modal()?.enabled ? language.t("settings.copy.enabled") : language.t("settings.copy.off")}
                      </span>
                      <Switch
                        hideLabel
                        checked={modal()?.enabled ?? false}
                        disabled={modalBusy()}
                        onChange={(value) => void toggle(value)}
                      >
                        {language.t("settings.copy.enableModal")}
                      </Switch>
                    </div>
                  </Show>
                  <Show when={!data.loading && !modal()?.connected && data()?.modal_file.ready}>
                    <div class="settings-compute-actions">
                      <Button
                        class="settings-panel-action"
                        size="small"
                        variant="secondary"
                        disabled={modalBusy()}
                        onClick={() => void configure()}
                      >
                        {isBusy("modal:configure")
                          ? language.t("settings.copy.configuring")
                          : language.t("settings.copy.useThisProfile")}
                      </Button>
                    </div>
                  </Show>
                </div>
                <Show when={connectionNotice()}>{(notice) => <NoticeBox notice={notice()} />}</Show>
                <Show when={!data.loading && !modal()?.connected && !data()?.modal_file.ready}>
                  <div class="flex flex-col gap-2">
                    <div class="settings-form-grid">
                      <Field
                        label={language.t("settings.copy.modalTokenId")}
                        value={token()}
                        placeholder="ak-…"
                        onInput={setToken}
                      />
                      <Field
                        label={language.t("settings.copy.modalTokenSecret")}
                        value={secret()}
                        placeholder="as-…"
                        type="password"
                        onInput={setSecret}
                      />
                    </div>
                    <div class="flex justify-end">
                      <Button
                        class="settings-panel-action"
                        size="small"
                        variant="primary"
                        disabled={!token().trim() || !secret().trim() || modalBusy()}
                        onClick={() => void connect()}
                      >
                        {isBusy("modal:connect")
                          ? language.t("settings.copy.saving2")
                          : language.t("settings.copy.saveToken")}
                      </Button>
                    </div>
                  </div>
                </Show>
                <Show when={modal()?.connected}>
                  <div class="settings-list-header">
                    <h4 class="text-12-medium text-text-weak">{language.t("settings.copy.jobDefaults")}</h4>
                  </div>
                  <div class="settings-form-grid">
                    <Field
                      label={language.t("settings.copy.modalApp")}
                      value={app()}
                      placeholder="openscience"
                      onInput={setApp}
                    />
                    <Field
                      label={language.t("settings.copy.defaultImage")}
                      value={image()}
                      placeholder="python:3.12-slim"
                      onInput={setImage}
                    />
                    <div class="flex min-w-0 flex-col gap-1.5">
                      <span class="text-12-medium text-text-strong">{language.t("settings.shell.panel.network")}</span>
                      <Select
                        aria-label={language.t("settings.copy.modalNetwork")}
                        options={networks}
                        current={networks.find((item) => item.value === network())}
                        value={(item) => item.value}
                        label={(item) => item.label}
                        onSelect={(item) => item && setNetwork(item.value)}
                        variant="secondary"
                        size="small"
                        triggerVariant="settings"
                      />
                    </div>
                    <Field
                      label={language.t("settings.copy.defaultTimeoutMinutes")}
                      value={timeout()}
                      placeholder="60"
                      inputMode="numeric"
                      onInput={setTimeout}
                    />
                    <Field
                      label={language.t("settings.copy.concurrentJobs")}
                      value={concurrency()}
                      placeholder="10"
                      inputMode="numeric"
                      onInput={setConcurrency}
                    />
                  </div>
                  <Show when={defaultsNotice()}>{(notice) => <NoticeBox notice={notice()} />}</Show>
                  <div class="settings-compute-actions">
                    <Button
                      class="settings-panel-action settings-panel-action--quiet"
                      type="button"
                      size="small"
                      variant="secondary"
                      disabled={!modal()?.enabled || modalBusy()}
                      onClick={() => void check()}
                    >
                      {isBusy("modal:check")
                        ? language.t("settings.copy.testing")
                        : language.t("settings.copy.testConnection")}
                    </Button>
                    <Button
                      class="settings-panel-action"
                      size="small"
                      variant="primary"
                      disabled={!app().trim() || !image().trim() || modalBusy()}
                      onClick={() => void saveModal()}
                    >
                      {isBusy("modal:save")
                        ? language.t("settings.copy.saving2")
                        : language.t("settings.copy.saveDefaults")}
                    </Button>
                  </div>
                  <p class="text-12-regular text-text-weak">
                    {language.t("settings.copy.credentialsStayLocalEveryDispatchStillRequiresApproval")}
                  </p>
                </Show>
              </div>
            </Card>
          </Section>

          <Section
            title={language.t("settings.copy.gpuProviderCredentials")}
            description={language.t("settings.copy.encryptedCredentialsForReviewedReadOnlyAgentOperations")}
          >
            <Card>
              <For each={cliProviders()}>
                {(item) => {
                  const rowBusy = () =>
                    hasBusyPrefix(`provider:`) && Object.keys(state.busy).some((key) => key.endsWith(item.id))
                  const status = () =>
                    item.connected
                      ? item.enabled
                        ? language.t("settings.copy.enabledForBroker")
                        : language.t("settings.copy.credentialSavedOff")
                      : language.t("settings.copy.notConfigured")
                  return (
                    <div class="settings-list-item" aria-busy={rowBusy() ? "true" : undefined}>
                      <div class="settings-list-row">
                        <span class="settings-row-logo" aria-hidden="true">
                          <ProviderLogo id={item.id} label={item.name} size="small" />
                        </span>
                        <div class="settings-list-copy min-w-0 flex-1">
                          <strong>{item.name}</strong>
                          <span
                            title={`Broker field ${item.credential.environment}${item.credential.aliases.length ? ` · aliases ${item.credential.aliases.join(", ")}` : ""}`}
                          >
                            {item.hint}
                            <Show when={item.last_used}>
                              {(value) => (
                                <>
                                  {" "}
                                  {language.t("settings.copy.lastUsed")}
                                  {new Date(value()).toLocaleDateString()}.
                                </>
                              )}
                            </Show>
                          </span>
                        </div>
                        <div class="settings-list-actions max-w-full flex-wrap justify-end">
                          <span class="settings-row-status">{status()}</span>
                          <Show when={item.connected}>
                            <Switch
                              hideLabel
                              checked={item.enabled}
                              disabled={rowBusy()}
                              onChange={(enabled) => void toggleProvider(item, enabled)}
                            >
                              {language.t("settings.copy.enable")}
                              {item.name} {language.t("settings.copy.credential")}
                            </Switch>
                            <Button
                              class="settings-panel-action settings-panel-action--quiet"
                              size="small"
                              variant="secondary"
                              disabled={rowBusy()}
                              aria-label={`Remove ${item.name} credential`}
                              onClick={() => void removeProvider(item)}
                            >
                              {language.t("settings.providerKeys.remove")}
                            </Button>
                          </Show>
                          <Show when={item.enabled}>
                            <Button
                              class="settings-panel-action settings-panel-action--quiet"
                              size="small"
                              variant="secondary"
                              disabled={rowBusy()}
                              onClick={() => void checkProvider(item)}
                            >
                              {isBusy(`provider:check:${item.id}`)
                                ? language.t("settings.copy.testing")
                                : language.t("settings.copy.testConnection")}
                            </Button>
                          </Show>
                          <Button
                            class="settings-panel-action settings-panel-action--quiet"
                            size="small"
                            variant="secondary"
                            disabled={rowBusy()}
                            onClick={() => {
                              setProviderKey(item.id, "")
                              setState("editingProvider", editingProvider() === item.id ? undefined : item.id)
                            }}
                          >
                            {editingProvider() === item.id
                              ? language.t("common.cancel")
                              : item.connected
                                ? language.t("settings.copy.update")
                                : language.t("settings.copy.addCredential")}
                          </Button>
                        </div>
                      </div>
                      <Show when={editingProvider() === item.id}>
                        <form
                          class="credential-form min-w-0"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void saveProvider(item)
                          }}
                        >
                          <label>
                            <span>{item.credential.label}</span>
                            <input
                              type="password"
                              autocomplete="off"
                              spellcheck={false}
                              disabled={rowBusy()}
                              value={providerKey(item.id)}
                              placeholder={
                                item.connected
                                  ? language.t("settings.copy.enterAReplacementCredential")
                                  : item.placeholder
                              }
                              onInput={(event) => setProviderKey(item.id, event.currentTarget.value)}
                            />
                          </label>
                          <p class="text-12-regular text-text-weak">
                            {language.t("settings.copy.storedEncryptedSavingANewCredentialLeavesThis")}
                          </p>
                          <div class="credential-form-actions max-w-full flex-wrap">
                            <Button
                              type="submit"
                              size="small"
                              variant="primary"
                              disabled={rowBusy() || !providerKey(item.id).trim()}
                            >
                              {isBusy(`provider:save:${item.id}`)
                                ? language.t("settings.copy.saving2")
                                : language.t("settings.copy.saveCredential")}
                            </Button>
                            <Button
                              type="button"
                              size="small"
                              variant="ghost"
                              disabled={rowBusy()}
                              onClick={() => platform.openLink(item.credential.docs_url)}
                            >
                              {language.t("settings.copy.officialSetupDocs")}
                            </Button>
                          </div>
                        </form>
                      </Show>
                      <Show when={!isBusy(`provider:check:${item.id}`) && providerCheck(item.id)}>
                        {(result) => (
                          <div class="credential-form min-w-0" role={result().ok ? "status" : "alert"}>
                            <p
                              class={
                                result().ok ? "text-12-regular text-text-success" : "text-12-regular text-text-danger"
                              }
                            >
                              {result().ok
                                ? `Verified with ${result().command}. No resource was created.`
                                : (result().error ??
                                  language.t("settings.copy.theNativeConnectionCheckDidNotComplete"))}
                            </p>
                          </div>
                        )}
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Card>
          </Section>

          <Section
            title={language.t("settings.copy.remoteHosts")}
            description={language.t("settings.copy.pinAHostKeyThenDispatchStagedJobs")}
          >
            <div class="settings-compute-remote" aria-busy={hasBusyPrefix("ssh:") ? "true" : undefined}>
              <Show
                when={!data.loading}
                fallback={
                  <Card>
                    <div
                      class="settings-panel-loading__rows"
                      role="status"
                      aria-label={language.t("settings.copy.loadingSshHosts")}
                    >
                      <span />
                      <span />
                    </div>
                  </Card>
                }
              >
                <Show
                  when={(data()?.ssh_hosts.length ?? 0) > 0}
                  fallback={
                    <Card>
                      <div class="settings-row settings-compute-summary-row">
                        <RowCopy
                          title={language.t("settings.copy.noRemoteHostsConnected")}
                          description={language.t("settings.copy.addAPlainSshSlurmOrPbsHost")}
                        />
                        <div class="settings-compute-summary-action">
                          <Button
                            class="settings-panel-action settings-panel-action--quiet"
                            size="small"
                            variant="secondary"
                            disabled={sshMutationBusy()}
                            onClick={() => setAdding(true)}
                          >
                            {language.t("settings.copy.addHost")}
                          </Button>
                        </div>
                      </div>
                    </Card>
                  }
                >
                  <Card>
                    <For each={data()?.ssh_hosts}>
                      {(item) => {
                        const probe = () => probes()[item.id]
                        return (
                          <>
                            <div class="settings-row settings-compute-host-row">
                              <div class="settings-compute-host-copy">
                                <div class="min-w-0 flex-1">
                                  <span class="block truncate text-14-medium text-text-strong">{item.label}</span>
                                  <p class="mt-0.5 truncate text-12-regular text-text-weak">
                                    {destination(item)}
                                    {item.workdir ? ` · ${item.workdir}` : ""}
                                  </p>
                                  <Show when={item.notes}>
                                    <p class="settings-compute-host-notes-copy">{item.notes}</p>
                                  </Show>
                                  <Show when={item.identity_file || item.proxy_jump}>
                                    <p class="mt-1 truncate text-12-regular text-text-weak">
                                      {item.identity_file
                                        ? `Identity ${item.identity_file}`
                                        : language.t("settings.copy.sshAgent")}
                                      {item.proxy_jump ? ` · via ${item.proxy_jump}` : ""}
                                    </p>
                                  </Show>
                                  <Show when={probe()}>
                                    {(result) => (
                                      <p
                                        class={
                                          result().ok
                                            ? "mt-1 text-12-regular text-text-success"
                                            : "mt-1 text-12-regular text-text-danger"
                                        }
                                      >
                                        {result().ok
                                          ? `${result().latency_ms} ms · ${capabilities(result())}`
                                          : result().error}
                                      </p>
                                    )}
                                  </Show>
                                  <Show when={item.fingerprint}>
                                    <p class="mt-1 truncate text-12-regular text-text-weak" title={item.fingerprint}>
                                      {item.fingerprint} · {item.concurrency}{" "}
                                      {language.t("settings.copy.concurrentJob")}
                                      {item.concurrency === 1 ? "" : "s"}
                                    </p>
                                  </Show>
                                </div>
                              </div>
                              <div class="settings-compute-host-actions">
                                <span class="settings-row-status">
                                  {probe()?.ok
                                    ? language.t("settings.copy.readyToDispatch")
                                    : item.fingerprint
                                      ? language.t("settings.copy.hostKeyPinned")
                                      : schedulerLabel(item.scheduler)}
                                </span>
                                <Button
                                  class="settings-panel-action settings-panel-action--quiet"
                                  size="small"
                                  variant="secondary"
                                  disabled={hostBusy(item.id) || sshMutationBusy()}
                                  onClick={() => void test(item)}
                                >
                                  {isBusy(`ssh:test:${item.id}`)
                                    ? language.t("settings.copy.testing")
                                    : language.t("settings.copy.test")}
                                </Button>
                                <Button
                                  class="settings-panel-action settings-panel-action--quiet"
                                  size="small"
                                  variant="ghost"
                                  disabled={hostBusy(item.id) || sshMutationBusy()}
                                  onClick={() => beginNotes(item)}
                                >
                                  {language.t("settings.copy.editNotes")}
                                </Button>
                                <Button
                                  class="settings-panel-action settings-panel-action--danger-quiet"
                                  size="small"
                                  variant="ghost"
                                  disabled={hostBusy(item.id) || sshMutationBusy()}
                                  onClick={() => void remove(item)}
                                >
                                  {language.t("settings.providerKeys.remove")}
                                </Button>
                              </div>
                            </div>
                            <Show when={editingHost() === item.id}>
                              <form
                                class="settings-compute-host-notes-editor"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  void saveNotes(item)
                                }}
                              >
                                <TextArea
                                  label={language.t("settings.copy.hostNotes")}
                                  value={notesDraft()}
                                  placeholder={language.t(
                                    "settings.copy.modulesPartitionsScratchPathsOrInstallationRules",
                                  )}
                                  onInput={setNotesDraft}
                                />
                                <p>{language.t("settings.copy.advisoryOnlyNotesAreShownDuringReviewAnd")}</p>
                                <div class="settings-inline-editor__actions">
                                  <Button
                                    class="settings-panel-action settings-panel-action--quiet"
                                    type="button"
                                    size="small"
                                    variant="ghost"
                                    disabled={isBusy(`ssh:update:${item.id}`)}
                                    onClick={cancelNotes}
                                  >
                                    {language.t("common.cancel")}
                                  </Button>
                                  <Button
                                    class="settings-panel-action"
                                    type="submit"
                                    size="small"
                                    variant="primary"
                                    disabled={isBusy(`ssh:update:${item.id}`)}
                                  >
                                    {isBusy(`ssh:update:${item.id}`)
                                      ? language.t("settings.copy.saving2")
                                      : language.t("settings.copy.saveNotes")}
                                  </Button>
                                </div>
                              </form>
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </Card>
                </Show>
              </Show>

              <Show when={configHosts().length > 0}>
                <div class="settings-compute-config-import">
                  <div class="settings-section-heading">
                    <div>
                      <h3>{language.t("settings.copy.fromSshConfig")}</h3>
                      <p>{language.t("settings.copy.literalHostEntriesOnlyPlusBoundedIncludesImports")}</p>
                    </div>
                  </div>
                  <Card>
                    <For each={configHosts()}>
                      {(item) => (
                        <div class="settings-row settings-compute-host-row">
                          <div class="settings-compute-host-copy">
                            <div class="min-w-0 flex-1">
                              <p class="text-14-medium text-text-strong">{item.alias}</p>
                              <p class="mt-0.5 truncate text-12-regular text-text-weak">
                                {[item.user, item.hostname ?? item.alias].filter(Boolean).join("@")}
                                {item.port ? `:${item.port}` : ""}
                                {item.proxy_jump ? ` · via ${item.proxy_jump}` : ""}
                              </p>
                            </div>
                          </div>
                          <div class="settings-compute-host-actions">
                            <Button
                              class="settings-panel-action settings-panel-action--quiet"
                              size="small"
                              variant="secondary"
                              disabled={sshMutationBusy() || isBusy(`ssh:import:${item.alias}`)}
                              onClick={() => void importHost(item)}
                            >
                              {isBusy(`ssh:import:${item.alias}`)
                                ? language.t("settings.copy.importing")
                                : language.t("settings.copy.import")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                  </Card>
                </div>
              </Show>

              <Show when={(data()?.ssh_hosts.length ?? 0) > 0 && !adding()}>
                <Button
                  class="settings-panel-action settings-panel-action--quiet self-start"
                  size="small"
                  variant="secondary"
                  disabled={sshMutationBusy()}
                  onClick={() => setAdding(true)}
                >
                  {language.t("settings.copy.addAnotherHost")}
                </Button>
              </Show>

              <Show when={adding()}>
                <form
                  class="settings-card settings-form-card"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void add()
                  }}
                >
                  <div class="flex items-start gap-3">
                    <div class="min-w-0">
                      <h4 class="text-14-medium text-text-strong">{language.t("settings.copy.newSshHost")}</h4>
                      <p class="mt-0.5 text-12-regular text-text-weak">
                        {language.t("settings.copy.opensciencePinsTestedHostKeysAndUsesYour")}
                      </p>
                    </div>
                  </div>
                  <div class="settings-form-grid">
                    <Field
                      label={language.t("dialog.project.edit.name")}
                      value={label()}
                      placeholder={language.t("settings.copy.labCluster")}
                      onInput={setLabel}
                    />
                    <Field
                      label={language.t("settings.copy.hostname")}
                      value={host()}
                      placeholder="hpc.example.edu"
                      onInput={setHost}
                    />
                    <Field
                      label={language.t("context.breakdown.user")}
                      value={user()}
                      placeholder={language.t("settings.copy.optional")}
                      onInput={setUser}
                    />
                    <Field
                      label={language.t("settings.copy.port")}
                      value={port()}
                      placeholder="22"
                      inputMode="numeric"
                      onInput={setPort}
                    />
                    <Field
                      label={language.t("settings.copy.identityFile")}
                      value={identityFile()}
                      placeholder={language.t("settings.copy.sshIdEd25519Optional")}
                      onInput={setIdentityFile}
                    />
                    <Field
                      label="ProxyJump"
                      value={proxyJump()}
                      placeholder={language.t("settings.copy.userBastionExampleOrg22Optional")}
                      onInput={setProxyJump}
                    />
                    <label class="flex min-w-0 flex-col gap-1.5">
                      <span class="text-12-medium text-text-strong">{language.t("settings.copy.scheduler")}</span>
                      <Select
                        aria-label={language.t("settings.copy.scheduler")}
                        options={schedulers}
                        current={schedulers.find((item) => item.value === scheduler())}
                        value={(item) => item.value}
                        label={(item) => item.label}
                        onSelect={(item) => item && setScheduler(item.value)}
                        variant="secondary"
                        size="small"
                        triggerVariant="settings"
                      />
                    </label>
                    <Field
                      label={language.t("settings.copy.remoteWorkingDirectory")}
                      value={workdir()}
                      placeholder="~/research"
                      onInput={setWorkdir}
                    />
                    <Field
                      label={language.t("settings.copy.concurrentJobs")}
                      value={sshConcurrency()}
                      placeholder="4"
                      inputMode="numeric"
                      onInput={setSshConcurrency}
                    />
                    <div data-span="full">
                      <TextArea
                        label={language.t("settings.copy.hostNotes")}
                        value={notes()}
                        placeholder={language.t("settings.copy.modulesPartitionsScratchPathsOrInstallationRules")}
                        onInput={setNotes}
                      />
                    </div>
                  </div>
                  <div class="settings-compute-actions">
                    <Button
                      class="settings-panel-action settings-panel-action--quiet"
                      type="button"
                      size="small"
                      variant="ghost"
                      disabled={isBusy("ssh:add")}
                      onClick={reset}
                    >
                      {language.t("common.cancel")}
                    </Button>
                    <Button
                      class="settings-panel-action"
                      type="submit"
                      size="small"
                      variant="primary"
                      disabled={!label().trim() || !host().trim() || sshMutationBusy()}
                    >
                      {isBusy("ssh:add") ? language.t("settings.copy.adding") : language.t("settings.copy.addHost")}
                    </Button>
                  </div>
                </form>
              </Show>
            </div>
          </Section>

          <CredentialServices
            category="compute"
            title={language.t("settings.copy.cloudCredentials")}
            description={language.t("settings.copy.credentialOnlyAccessForReviewedCliSdkAnd")}
          />
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

export default Compute

const Field: Component<{
  label: string
  value: string
  placeholder: string
  type?: JSX.InputHTMLAttributes<HTMLInputElement>["type"]
  inputMode?: JSX.InputHTMLAttributes<HTMLInputElement>["inputMode"]
  onInput: (value: string) => void
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1.5">
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <input
      class="settings-field"
      value={props.value}
      placeholder={props.placeholder}
      type={props.type}
      inputMode={props.inputMode}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)

const TextArea: Component<{
  label: string
  value: string
  placeholder: string
  onInput: (value: string) => void
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1.5">
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <textarea
      class="settings-field settings-compute-notes-field"
      value={props.value}
      placeholder={props.placeholder}
      maxlength={4_000}
      rows={3}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)

const networks: Array<{ value: Modal["network"]; label: string }> = [
  { value: "none", label: "Blocked" },
  { value: "unrestricted", label: "Unrestricted" },
]

const NoticeBox: Component<{ notice: Notice }> = (props) => (
  <div
    role={props.notice.tone === "error" ? "alert" : "status"}
    aria-live="polite"
    class="settings-alert !items-start"
    data-tone={props.notice.tone === "error" ? "critical" : undefined}
    classList={{
      "text-text-success": props.notice.tone === "success",
    }}
  >
    <Show when={props.notice.tone !== "neutral"}>
      <div class="settings-alert__icon" aria-hidden="true">
        <Icon name={props.notice.tone === "success" ? "circle-check" : "alert-circle"} size="small" />
      </div>
    </Show>
    <div class="min-w-0">
      <p
        class="text-12-medium"
        classList={{
          "text-text-strong": props.notice.tone === "neutral",
          "text-text-success": props.notice.tone === "success",
          "text-text-danger": props.notice.tone === "error",
        }}
      >
        {props.notice.title}
      </p>
      <Show when={props.notice.detail}>
        <p class="mt-0.5 text-12-regular text-text-weak">{props.notice.detail}</p>
      </Show>
    </div>
  </div>
)

const Badge: Component<{ tone: "ready" | "muted"; children: JSX.Element }> = (props) => (
  <div class="settings-status" data-tone={props.tone}>
    <Show when={props.tone === "ready"}>
      <span class="settings-status__dot" aria-hidden="true" />
    </Show>
    {props.children}
  </div>
)

function destination(host: Host) {
  const login = host.user ? `${host.user}@${host.host}` : host.host
  return host.port ? `${login}:${host.port}` : login
}

function schedulerLabel(scheduler: Scheduler) {
  if (scheduler === "slurm") return "Slurm"
  if (scheduler === "pbs") return "PBS"
  return "SSH"
}

function capabilities(probe: Probe) {
  const values = [
    probe.hostname,
    probe.python ? "Python" : undefined,
    probe.gpu ? "GPU" : undefined,
    probe.slurm ? "Slurm" : undefined,
    probe.pbs ? "PBS" : undefined,
  ]
  return values.filter((value): value is string => Boolean(value)).join(" · ") || "SSH ready"
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
