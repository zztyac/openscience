import { createEffect, createUniqueId, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { MaterialActivitySnapshot, MaterialProject, type MaterialDecision } from "@synsci/util/materials"
import { SettingsApiError } from "@/components/settings/api"
import { Analysis, Ideas, Overview, Protocol, Sources, Strategies, type PanelProps } from "./panels"
import type { Translator } from "./i18n"
import { download } from "./files"
import { MaterialActivityPanel } from "./activity"
import { MaterialLibraryPanel, type MaterialLibraryNavigation } from "./library"
import "./styles.css"

type Tab = "overview" | "literature" | "strategies" | "ideas" | "protocol" | "analysis"
const tabs: Tab[] = ["overview", "literature", "strategies", "ideas", "protocol", "analysis"]
const running = (project?: MaterialProject) => project?.status === "running" || project?.status === "queued"
export type MaterialRequest = <T>(path: string, init?: RequestInit) => Promise<T>

/** This card lives inside a persisted tool result in the original conversation. */
export function MaterialSessionCard(props: {
  projectID: string
  request: MaterialRequest
  t: Translator
  locale: string
  navigation?: MaterialLibraryNavigation
}) {
  const tabID = createUniqueId()
  const [state, setState] = createStore({
    project: undefined as MaterialProject | undefined,
    loading: true,
    busy: false,
    error: "",
    pollError: "",
    tab: "overview" as Tab,
    activity: undefined as MaterialActivitySnapshot | undefined,
    receivedAt: undefined as number | undefined,
    lastSuccessAt: undefined as number | undefined,
    connected: false,
    legacy: false,
    libraryRefresh: 0,
  })
  const requests = new Set<AbortController>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let alive = true
  let generation = 0
  let full: { epoch: number; promise: Promise<MaterialProject | undefined> } | undefined
  let polling: { epoch: number; promise: Promise<void> } | undefined

  async function request<T>(suffix = "", init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    requests.add(controller)
    const timeout = setTimeout(() => controller.abort(new Error(props.t("unavailable"))), 20000)
    try {
      return await props.request<T>(`/materials/projects/${encodeURIComponent(props.projectID)}${suffix}`, {
        ...init,
        signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      })
    } finally {
      clearTimeout(timeout)
      requests.delete(controller)
    }
  }
  function message(error: unknown) {
    if (error instanceof SettingsApiError && error.status === 409 && error.message.includes("课题已更新"))
      return props.t("stale")
    if (error instanceof TypeError) return props.t("unavailable")
    return error instanceof Error ? error.message : String(error)
  }
  function update(project: MaterialProject) {
    if (!alive || project.id !== props.projectID || (state.project && project.revision < state.project.revision)) return
    setState("project", reconcile(project))
  }
  function success(epoch: number) {
    if (alive && epoch === generation) setState({ pollError: "", connected: true, lastSuccessAt: Date.now() })
  }
  function failure(error: unknown, epoch: number) {
    if (alive && epoch === generation) setState({ pollError: message(error), connected: false })
  }
  function refreshProject() {
    const epoch = generation
    if (full?.epoch === epoch) return full.promise
    const promise = (async () => {
      try {
        const project = MaterialProject.parse(await request<MaterialProject>())
        if (!alive || epoch !== generation) return
        update(project)
        success(epoch)
        return project
      } catch (error) {
        failure(error, epoch)
      } finally {
        if (alive && epoch === generation) setState("loading", false)
      }
    })()
    const flight = { epoch, promise }
    full = flight
    void promise.finally(() => {
      if (full === flight) full = undefined
    })
    return promise
  }
  function poll() {
    const epoch = generation
    if (polling?.epoch === epoch) return polling.promise
    const promise = (async () => {
      if (state.legacy || !state.project) {
        await refreshProject()
        return
      }
      try {
        const snapshot = MaterialActivitySnapshot.parse(await request<MaterialActivitySnapshot>("/activity"))
        if (!alive || epoch !== generation || snapshot.projectID !== props.projectID) return
        success(epoch)
        // Mutations can complete while a poll is in flight. Older snapshots must
        // not restart a cancelled operation or replace a newer activity record.
        if (snapshot.revision < state.project.revision || snapshot.serverTime < (state.activity?.serverTime ?? 0))
          return
        setState("activity", reconcile(snapshot))
        setState("receivedAt", Date.now())
        if (snapshot.revision !== state.project.revision) await refreshProject()
      } catch (error) {
        if (!alive || epoch !== generation) return
        if (error instanceof SettingsApiError && error.status === 404) {
          setState({ legacy: true, activity: undefined })
          await refreshProject()
          return
        }
        failure(error, epoch)
      }
    })()
    const flight = { epoch, promise }
    polling = flight
    void promise.finally(() => {
      if (polling === flight) polling = undefined
    })
    return promise
  }
  function schedule(epoch = generation) {
    if (!alive || epoch !== generation) return
    clearTimeout(timer)
    timer = setTimeout(
      async () => {
        await poll()
        schedule(epoch)
      },
      document.hidden ? 15000 : running(state.project) ? 2000 : 10000,
    )
  }
  async function refresh(reloadLibrary = true) {
    const epoch = generation
    clearTimeout(timer)
    const project = await refreshProject()
    if (!alive || epoch !== generation) return
    if (project) await poll()
    if (alive && epoch === generation && reloadLibrary) setState("libraryRefresh", (value) => value + 1)
    schedule(epoch)
    return project
  }
  createEffect(
    on(
      () => props.projectID,
      () => {
        generation++
        clearTimeout(timer)
        for (const controller of requests) controller.abort()
        setState({
          project: undefined,
          loading: true,
          busy: false,
          error: "",
          pollError: "",
          tab: "overview",
          activity: undefined,
          receivedAt: undefined,
          lastSuccessAt: undefined,
          connected: false,
          legacy: false,
        })
        void refresh(false)
      },
    ),
  )
  onCleanup(() => {
    alive = false
    clearTimeout(timer)
    for (const controller of requests) controller.abort()
  })

  async function mutate(suffix: string, body: Record<string, unknown>, cancel = false, file?: File) {
    if (state.busy) return false
    const epoch = generation
    setState({ busy: true, error: "" })
    try {
      const send = (value: Record<string, unknown>) => {
        if (!file) return request<MaterialProject>(suffix, { method: "POST", body: JSON.stringify(value) })
        const form = new FormData()
        form.set("file", file)
        form.set("source", JSON.stringify(value))
        return request<MaterialProject>(suffix, { method: "POST", body: form })
      }
      const result = await send(body).catch(async (error: unknown) => {
        if (!(error instanceof SettingsApiError) || error.status !== 409) throw error
        if (!alive || epoch !== generation) throw error
        const latest = await refreshProject()
        if (!cancel || !latest || epoch !== generation) throw error
        if (latest.status === "cancelled") return latest
        if (!running(latest)) throw error
        return send({ ...body, revision: latest.revision })
      })
      if (!alive || epoch !== generation) return false
      update(MaterialProject.parse(result))
      setState("error", "")
      success(epoch)
      void poll().then(() => schedule(epoch))
      return true
    } catch (error) {
      if (alive && epoch === generation) setState("error", message(error))
      return false
    } finally {
      if (alive && epoch === generation) setState("busy", false)
    }
  }
  const action = (value: Omit<(typeof MaterialDecision)["_output"], "revision">) =>
    mutate("/actions", { ...value, revision: state.project?.revision }, value.action === "cancel")
  async function exportProject() {
    if (state.busy) return
    const epoch = generation
    setState({ busy: true, error: "" })
    try {
      const project = await request<MaterialProject>("/export")
      if (!alive || epoch !== generation) return
      download(`materials-${props.projectID}.json`, JSON.stringify(project, null, 2))
    } catch (error) {
      if (alive && epoch === generation) setState("error", message(error))
    } finally {
      if (alive && epoch === generation) setState("busy", false)
    }
  }
  const panel: PanelProps = {
    get project() {
      return state.project!
    },
    get t() {
      return props.t
    },
    get locale() {
      return props.locale
    },
    get busy() {
      return state.busy
    },
    action,
    saveSource: (value, file) => mutate(file ? "/sources/upload" : "/sources", value, false, file),
    saveBatch: (value) => mutate("/batches", { ...value, revision: state.project?.revision }),
  }
  return (
    <section class="mat-session" aria-label={props.t("researchRecord")}>
      <Show when={state.error || state.pollError}>
        <div class="mat-error" role="alert">
          <span>{state.error || state.pollError}</span>
          <button
            class="mat-button"
            onClick={() => {
              setState("error", "")
              void refresh()
            }}
          >
            {props.t("refresh")}
          </button>
        </div>
      </Show>
      <Show
        when={state.project}
        fallback={
          <p class="mat-muted" role="status">
            {state.loading ? props.t("loading") : props.t("unavailable")}
          </p>
        }
      >
        {(project) => (
          <>
            <header class="mat-session-header">
              <div>
                <h3>{project().title}</h3>
                <span class="mat-badge" data-status={project().status}>
                  {props.t(project().status)}
                </span>
              </div>
              <div class="mat-session-actions">
                <Show when={running(project())}>
                  <button class="mat-button" disabled={state.busy} onClick={() => void action({ action: "cancel" })}>
                    {props.t("cancel")}
                  </button>
                </Show>
                <Show when={["draft", "failed", "cancelled", "interrupted"].includes(project().status)}>
                  <button
                    class="mat-button"
                    disabled={state.busy}
                    onClick={() => void action({ action: project().status === "draft" ? "start" : "resume" })}
                  >
                    {props.t("retry")}
                  </button>
                </Show>
                <button class="mat-button" disabled={state.busy} onClick={() => void exportProject()}>
                  {props.t("export")}
                </button>
                <button
                  class="mat-button"
                  disabled={state.loading}
                  onClick={() => {
                    setState("error", "")
                    void refresh()
                  }}
                >
                  {props.t("refresh")}
                </button>
              </div>
            </header>
            <Show when={project().error}>
              <p role="alert" class="mat-error">
                {project().error}
              </p>
            </Show>
            <ol class="mat-pipeline">
              <For each={project().stages}>
                {(step, index) => (
                  <li data-status={step.status}>
                    <button onClick={() => setState("tab", step.key === "intake" ? "overview" : step.key)}>
                      <span class="mat-stage-number">{step.status === "completed" ? "✓" : index() + 1}</span>
                      <span>
                        {props.t(step.key)}
                        <small>{props.t(step.status)}</small>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ol>
            <MaterialActivityPanel
              project={project()}
              snapshot={state.activity}
              receivedAt={state.receivedAt}
              lastSuccessAt={state.lastSuccessAt}
              connected={state.connected}
              legacy={state.legacy}
              locale={props.locale}
              t={props.t}
            />
            <MaterialLibraryPanel
              project={project()}
              request={request}
              navigation={props.navigation}
              refreshKey={state.libraryRefresh}
              t={props.t}
            />
            <nav class="mat-tabs" role="tablist" aria-label={props.t("artifacts")}>
              <For each={tabs}>
                {(tab) => (
                  <button
                    role="tab"
                    id={`${tabID}-${tab}`}
                    aria-selected={state.tab === tab}
                    aria-controls={`${tabID}-panel`}
                    tabIndex={state.tab === tab ? 0 : -1}
                    onClick={() => setState("tab", tab)}
                    onKeyDown={(event) => {
                      const index = tabs.indexOf(tab)
                      const next =
                        event.key === "ArrowRight"
                          ? tabs[(index + 1) % tabs.length]
                          : event.key === "ArrowLeft"
                            ? tabs[(index + tabs.length - 1) % tabs.length]
                            : event.key === "Home"
                              ? tabs[0]
                              : event.key === "End"
                                ? tabs.at(-1)
                                : undefined
                      if (!next) return
                      event.preventDefault()
                      setState("tab", next)
                      document.getElementById(`${tabID}-${next}`)?.focus()
                    }}
                  >
                    {props.t(tab)}
                  </button>
                )}
              </For>
            </nav>
            <div class="mat-tab-panel" role="tabpanel" id={`${tabID}-panel`} aria-labelledby={`${tabID}-${state.tab}`}>
              <Switch>
                <Match when={state.tab === "overview"}>
                  <Overview {...panel} />
                </Match>
                <Match when={state.tab === "literature"}>
                  <Sources {...panel} />
                </Match>
                <Match when={state.tab === "strategies"}>
                  <Strategies {...panel} />
                </Match>
                <Match when={state.tab === "ideas"}>
                  <Ideas {...panel} />
                </Match>
                <Match when={state.tab === "protocol"}>
                  <Protocol {...panel} />
                </Match>
                <Match when={state.tab === "analysis"}>
                  <Analysis {...panel} />
                </Match>
              </Switch>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
