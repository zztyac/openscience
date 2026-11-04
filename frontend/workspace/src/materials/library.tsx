import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { MaterialLibrarySnapshot, type MaterialLibraryFile, type MaterialProject } from "@synsci/util/materials"
import { SettingsApiError } from "@/components/settings/api"
import type { MaterialText, Translator } from "./i18n"
import type { MaterialRequest } from "./session-card"

export type MaterialLibraryNavigation = {
  directory: (library: MaterialLibrarySnapshot) => void | Promise<void>
  file: (library: MaterialLibrarySnapshot, file: MaterialLibraryFile) => void | Promise<void>
  results: (library: MaterialLibrarySnapshot) => void | Promise<void>
  result: (library: MaterialLibrarySnapshot, file: MaterialLibraryFile) => void | Promise<void>
}
const statuses: Record<MaterialLibrarySnapshot["status"], MaterialText> = {
  unbound: "libraryUnbound",
  pending: "libraryPending",
  syncing: "librarySyncing",
  synced: "librarySynced",
  partial: "libraryPartial",
  error: "libraryFailed",
}
const kinds: Record<MaterialLibraryFile["kind"], MaterialText> = {
  paper: "libraryPaper",
  data: "libraryData",
  report: "libraryReport",
  index: "libraryIndex",
}

/** Metadata only. Scientific content continues to use the project's stage artifacts. */
export function MaterialLibraryPanel(props: {
  project: MaterialProject
  request: MaterialRequest
  navigation?: MaterialLibraryNavigation
  refreshKey: number
  t: Translator
}) {
  const [state, setState] = createStore({
    snapshot: undefined as MaterialLibrarySnapshot | undefined,
    loading: false,
    syncing: false,
    error: "",
    unsupported: false,
  })
  let epoch = 0
  let projectID = ""
  let alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { epoch: number; promise: Promise<void>; controller: AbortController } | undefined
  let again = false
  let notification = ""
  let checkSync = false
  const owns = (generation: number) => alive && epoch === generation
  function schedule() {
    clearTimeout(timer)
    if (
      !alive ||
      state.unsupported ||
      (!checkSync && (!state.snapshot || (!stale() && !["pending", "syncing"].includes(state.snapshot.status))))
    )
      return
    timer = setTimeout(() => void load(), document.hidden ? 15000 : 10000)
  }
  function load(sync = false): Promise<void> {
    clearTimeout(timer)
    if (pending?.epoch === epoch) {
      if (!sync) again = true
      return pending.promise
    }
    const generation = epoch
    const controller = new AbortController()
    setState({ loading: true, syncing: sync, error: "" })
    const promise = (async () => {
      try {
        const snapshot = MaterialLibrarySnapshot.parse(
          await props.request<MaterialLibrarySnapshot>("/library", {
            signal: controller.signal,
            ...(sync ? { method: "POST", body: "{}" } : {}),
          }),
        )
        if (!owns(generation) || snapshot.materialsProjectID !== props.project.id) return
        checkSync = false
        if (
          state.snapshot?.revision !== undefined &&
          snapshot.revision !== undefined &&
          snapshot.revision < state.snapshot.revision
        )
          return
        setState("snapshot", reconcile(snapshot))
        setState("unsupported", false)
        const version = JSON.stringify(
          snapshot.files.filter((file) => file.resultID).map((file) => [file.resultID, file.resultVersionID]),
        )
        if (version !== notification && version !== "[]")
          window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
        notification = version
      } catch (error) {
        if (!owns(generation) || controller.signal.aborted) return
        if (sync) checkSync = true
        if (error instanceof SettingsApiError && error.status === 404) setState("unsupported", true)
        else setState("error", error instanceof Error ? error.message : String(error))
      } finally {
        if (owns(generation)) setState({ loading: false, syncing: false })
      }
    })()
    const flight = { epoch: generation, promise, controller }
    pending = flight
    void promise.finally(() => {
      if (pending !== flight) return
      pending = undefined
      if (!owns(generation)) return
      if (again) {
        again = false
        void load()
        return
      }
      schedule()
    })
    return promise
  }
  createEffect(
    on(
      () => [props.project.id, props.project.revision, props.refreshKey] as const,
      () => {
        if (projectID !== props.project.id) {
          projectID = props.project.id
          epoch++
          pending?.controller.abort()
          again = false
          notification = ""
          checkSync = false
          setState({ snapshot: undefined, error: "", unsupported: false })
        }
        void load()
      },
    ),
  )
  onCleanup(() => {
    alive = false
    epoch++
    clearTimeout(timer)
    pending?.controller.abort()
  })
  async function open(action: (snapshot: MaterialLibrarySnapshot) => void | Promise<void>) {
    const snapshot = state.snapshot
    const generation = epoch
    if (!snapshot) return
    setState("error", "")
    try {
      await action(snapshot)
    } catch (error) {
      if (owns(generation)) setState("error", error instanceof Error ? error.message : String(error))
    }
  }
  const stale = () => state.snapshot?.revision !== undefined && state.snapshot.revision < props.project.revision
  return (
    <section class="mat-library" aria-label={props.t("libraryTitle")}>
      <div class="mat-library-heading">
        <h4>{props.t("libraryTitle")}</h4>
        <span role="status">
          {state.unsupported
            ? props.t("libraryUnsupported")
            : state.syncing
              ? props.t("librarySyncing")
              : state.snapshot
                ? props.t(stale() ? "libraryPending" : statuses[state.snapshot.status])
                : props.t(state.error ? "libraryFailed" : "loading")}
        </span>
      </div>
      <Show when={state.snapshot?.root}>
        {(root) => (
          <p class="mat-library-location">
            <span>{props.t("libraryLocation")}</span>
            <code>{root()}</code>
          </p>
        )}
      </Show>
      <Show when={state.snapshot?.location === "scratch"}>
        <p class="mat-muted">{props.t("libraryScratch")}</p>
      </Show>
      <Show when={state.snapshot?.message}>{(message) => <p class="mat-muted">{message()}</p>}</Show>
      <Show when={state.snapshot?.status === "unbound"}>
        <p class="mat-muted">{props.t("libraryUnboundHint")}</p>
      </Show>
      <Show when={stale() || state.snapshot?.status === "pending" || state.snapshot?.status === "syncing"}>
        <p class="mat-muted">{props.t("libraryPendingHint")}</p>
      </Show>
      <Show when={state.error}>
        <p class="mat-error" role="alert">
          {state.error}
        </p>
      </Show>
      <Show when={state.snapshot?.warnings.length}>
        <ul class="mat-library-warnings">
          <For each={state.snapshot!.warnings}>{(warning) => <li>{warning}</li>}</For>
        </ul>
      </Show>
      <div class="mat-library-actions">
        <Show when={props.navigation && state.snapshot?.root}>
          <button class="mat-button" onClick={() => void open(props.navigation!.directory)}>
            {props.t("libraryOpenDirectory")}
          </button>
        </Show>
        <Show when={props.navigation && state.snapshot?.projectID}>
          <button class="mat-button" onClick={() => void open(props.navigation!.results)}>
            {props.t("libraryOpenResults")}
          </button>
        </Show>
        <button class="mat-button" disabled={state.loading || state.unsupported} onClick={() => void load(true)}>
          {props.t("librarySync")}
        </button>
      </div>
      <Show when={state.snapshot?.files.length}>
        <details class="mat-library-files">
          <summary>
            {props.t("libraryFiles")} · {state.snapshot!.files.length}
          </summary>
          <ul>
            <For each={state.snapshot!.files}>
              {(file) => (
                <li>
                  <div>
                    <span class="mat-type">{props.t(kinds[file.kind])}</span>
                    <strong>{file.title}</strong>
                    <small>{file.path}</small>
                  </div>
                  <Show when={props.navigation}>
                    <div class="mat-library-file-actions">
                      <button
                        class="mat-button"
                        onClick={() => void open((snapshot) => props.navigation!.file(snapshot, file))}
                      >
                        {props.t("libraryOpenFile")}
                      </button>
                      <Show when={file.resultID}>
                        <button
                          class="mat-button"
                          onClick={() => void open((snapshot) => props.navigation!.result(snapshot, file))}
                        >
                          {props.t("libraryOpenResult")}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  )
}
