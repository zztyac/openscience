import { useLanguage } from "@/context/language"
import { For, Show, createMemo, createResource, onCleanup, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { FolderPicker } from "@/atlas/FolderPicker"
import { confirmDialog } from "@/atlas/dialogs"
import { fileSourceName, parseFilesystemSnapshot, type FilesystemGrant } from "@/atlas/file-sources"
import { createProjectRequest, type ProjectRequest } from "@/utils/openscience-fetch"
import { NativeDirectoryPickerUnavailable } from "@/utils/native-picker"
import { resolveProjectRoute } from "@/utils/project-route"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import "./workspaces.css"

export function WorkspaceFolders(props: {
  request: ProjectRequest
  projectID: string
  directory: string
  choose?: () => Promise<string | undefined>
  confirm?: (folder: FilesystemGrant) => Promise<boolean>
  watch?: (refresh: () => void) => () => void
}) {
  const language = useLanguage()
  const [state, set] = createStore({ path: "", access: "write" as "read" | "write", busy: false, error: "" })
  const lifetime = new AbortController()
  onCleanup(() => lifetime.abort())
  const request = async (path: string, init?: RequestInit) => {
    const response = await props.request(path, init)
    const body = await response.json()
    if (!response.ok)
      throw new Error(body?.data?.message || body?.message || language.t("settings.copy.folderSettingsCouldNotBeSaved"))
    return body as unknown
  }
  const [snapshot, actions] = createResource(async () => {
    const body = await request("/project/current/filesystem")
    const value = parseFilesystemSnapshot(body, { projectID: props.projectID, directory: props.directory })
    if (!value) throw new Error(language.t("settings.copy.folderSettingsBelongToADifferentWorkspace"))
    return value
  })
  const watch = props.watch?.(() => void actions.refetch())
  if (watch) onCleanup(watch)
  const folders = () => snapshot.latest?.grants.filter((grant) => !grant.time.revoked && !grant.time.consumed) ?? []
  const unavailable = () => {
    const root = snapshot.latest?.workingRoot
    return root && root !== "scratch" && !folders().some((folder) => folder.path === root && folder.access === "write")
      ? root
      : undefined
  }
  const mutate = async (action: () => Promise<unknown>) => {
    if (state.busy) return
    set({ busy: true, error: "" })
    await action()
      .then(async () => {
        if (lifetime.signal.aborted) return
        set("path", "")
        await actions.refetch()
      })
      .catch((error) => {
        if (!lifetime.signal.aborted) set("error", error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!lifetime.signal.aborted) set("busy", false)
      })
  }
  const connect = (path: string, access: "read" | "write") =>
    mutate(() =>
      request("/project/current/filesystem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, access }),
      }),
    )
  const working = (workingRoot: string | null) =>
    mutate(() =>
      request("/project/current/working-root", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workingRoot }),
      }),
    )
  const disconnect = async (folder: FilesystemGrant) => {
    if (state.busy || (props.confirm && !(await props.confirm(folder))) || lifetime.signal.aborted) return
    await mutate(() => request(`/project/current/filesystem/${encodeURIComponent(folder.id)}`, { method: "DELETE" }))
  }
  const browse = async () => {
    if (!props.choose || state.busy) return
    set({ busy: true, error: "" })
    await props
      .choose()
      .then(
        (path) => {
          if (!lifetime.signal.aborted && path) set("path", path)
        },
        (error) => {
          if (!lifetime.signal.aborted) set("error", error instanceof Error ? error.message : String(error))
        },
      )
      .finally(() => {
        if (!lifetime.signal.aborted) set("busy", false)
      })
  }
  return (
    <div class="workspace-folders" aria-label={language.t("settings.copy.workspaceFolders")} aria-busy={state.busy}>
      <Show
        when={!snapshot.error}
        fallback={
          <div class="settings-alert" role="alert">
            <span>{language.t("settings.copy.foldersCouldNotBeLoaded")}</span>
            <Button onClick={() => void actions.refetch()}>{language.t("settings.connectors.retry")}</Button>
          </div>
        }
      >
        <Show when={snapshot.latest} fallback={<p role="status">{language.t("settings.copy.loadingFolders")}</p>}>
          <div class="workspace-folders__list">
            <For
              each={folders()}
              fallback={
                <p class="workspace-folders__empty">{language.t("settings.copy.noFoldersConnectedAddOneToWorkWith")}</p>
              }
            >
              {(folder) => (
                <div class="workspace-folders__item">
                  <Icon name="folder" size="normal" />
                  <div class="workspace-folders__copy">
                    <strong>{fileSourceName(folder.path)}</strong>
                    <span title={folder.path}>{folder.path}</span>
                    <Show when={snapshot.latest?.toolDirectory === folder.path}>
                      <small>{language.t("settings.copy.defaultWorkingFolder")}</small>
                    </Show>
                  </div>
                  <div class="workspace-folders__actions">
                    <select
                      aria-label={`Access to ${folder.path}`}
                      value={folder.access}
                      disabled={state.busy}
                      onChange={(event) => void connect(folder.path, event.currentTarget.value as "read" | "write")}
                    >
                      <option value="write">{language.t("settings.copy.readWrite")}</option>
                      <option value="read">{language.t("settings.copy.readOnly")}</option>
                    </select>
                    <Show when={folder.access === "write" && snapshot.latest?.toolDirectory !== folder.path}>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={state.busy}
                        onClick={() => void working(folder.path)}
                        aria-label={`Use ${folder.path} by default`}
                      >
                        {language.t("settings.copy.useByDefault")}
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={state.busy}
                      onClick={() => void disconnect(folder)}
                      aria-label={`Disconnect ${folder.path}`}
                    >
                      {language.t("settings.models.codexDisconnect")}
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>
          <form
            class="workspace-folders__add"
            onSubmit={(event) => {
              event.preventDefault()
              if (state.path.trim()) void connect(state.path.trim(), state.access)
            }}
          >
            <label class="workspace-folders__path">
              <span>{language.t("settings.copy.connectAFolder")}</span>
              <input
                aria-label={language.t("settings.copy.folderPath")}
                placeholder="/path/to/folder"
                value={state.path}
                disabled={state.busy}
                spellcheck={false}
                autocomplete="off"
                onInput={(event) => set("path", event.currentTarget.value)}
              />
            </label>
            <div class="workspace-folders__controls">
              <select
                aria-label={language.t("settings.copy.newFolderAccess")}
                value={state.access}
                disabled={state.busy}
                onChange={(event) => set("access", event.currentTarget.value as "read" | "write")}
              >
                <option value="write">{language.t("settings.copy.readWrite")}</option>
                <option value="read">{language.t("settings.copy.readOnly")}</option>
              </select>
              <Show when={props.choose}>
                <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void browse()}>
                  {language.t("settings.copy.browse")}
                </Button>
              </Show>
              <Button type="submit" variant="primary" disabled={state.busy || !state.path.trim()}>
                {language.t("settings.copy.connectFolder")}
              </Button>
            </div>
          </form>
          <Show when={folders().some((folder) => folder.access === "write") || snapshot.latest?.workingRoot}>
            <label class="workspace-folders__default">
              <span>{language.t("settings.copy.defaultLocationForNewConversations")}</span>
              <select
                aria-label={language.t("settings.copy.defaultWorkingFolder")}
                disabled={state.busy}
                value={snapshot.latest?.workingRoot ?? ""}
                onChange={(event) => void working(event.currentTarget.value || null)}
              >
                <option value="">{language.t("settings.copy.automatic")}</option>
                <Show when={unavailable()}>
                  {(root) => (
                    <option value={root()} disabled>
                      {language.t("settings.copy.previousFolderUnavailableUsingScratch")}
                    </option>
                  )}
                </Show>
                <For each={folders().filter((folder) => folder.access === "write")}>
                  {(folder) => (
                    <option value={folder.path}>
                      {fileSourceName(folder.path)} — {folder.path}
                    </option>
                  )}
                </For>
                <option value="scratch">{language.t("settings.copy.temporaryScratch")}</option>
              </select>
            </label>
          </Show>
        </Show>
      </Show>
      <Show when={state.error}>
        <p class="workspace-folders__error" role="alert">
          {state.error}
        </p>
      </Show>
      <p class="workspace-folders__hint">{language.t("settings.copy.connectedFoldersAreSharedByThisProjectS")}</p>
    </div>
  )
}

const Workspaces: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const params = useParams()
  const [state, set] = createStore({ project: "" })
  const projects = () => sync.data.project.filter((project) => !project.time.archived)
  const selected = createMemo(
    () =>
      projects().find(
        (project) => project.id === (state.project || resolveProjectRoute(params.dir, projects())?.projectID),
      ) ?? projects()[0],
  )
  const choose = async () => {
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform
        .openDirectoryPickerDialog({ title: language.t("settings.copy.connectAFolder"), serverUrl: sdk.url })
        .catch((error) => {
          if (error instanceof NativeDirectoryPickerUnavailable) return undefined
          throw error
        })
      if (result !== undefined) return Array.isArray(result) ? result[0] : (result ?? undefined)
    }
    return new Promise<string | undefined>((resolve) =>
      dialog.show(
        () => (
          <FolderPicker
            kind="folder"
            title={language.t("settings.copy.connectAFolder")}
            onSelect={(value) => resolve(Array.isArray(value) ? value[0] : (value ?? undefined))}
          />
        ),
        { onClose: () => resolve(undefined), stack: true },
      ),
    )
  }
  return (
    <PanelScroll>
      <PanelHeader
        title={language.t("settings.shell.panel.workspaces")}
        description={language.t("settings.copy.chooseWhereEachProjectWorksAndWhichFolders")}
      />
      <PanelBody>
        <Show
          when={selected()}
          fallback={<p class="settings-card-empty">{language.t("settings.copy.createAProjectToConnectItsFolders")}</p>}
          keyed
        >
          {(project) => {
            const request = createProjectRequest({
              baseUrl: () => sdk.url,
              projectID: () => project.id,
              directory: () => project.worktree,
              fetch: () => platform.fetch ?? fetch,
            })
            return (
              <>
                <label class="workspace-project">
                  <span>{language.t("command.category.project")}</span>
                  <select
                    aria-label={language.t("settings.copy.projectWorkspace")}
                    value={project.id}
                    onChange={(event) => set("project", event.currentTarget.value)}
                  >
                    <For each={projects()}>
                      {(item) => (
                        <option value={item.id}>{item.name || language.t("settings.copy.untitledProject")}</option>
                      )}
                    </For>
                  </select>
                </label>
                <Section
                  title={language.t("settings.copy.folders")}
                  description={language.t("settings.copy.workWithYourExistingFilesFromTheFirst")}
                >
                  <WorkspaceFolders
                    request={request}
                    projectID={project.id}
                    directory={project.worktree}
                    choose={choose}
                    watch={(refresh) =>
                      sdk.event.on(project.worktree, (event) => {
                        if (event.type === "session.filesystem.changed" || event.type === "project.updated") refresh()
                      })
                    }
                    confirm={(folder) =>
                      confirmDialog(dialog, {
                        title: language.t("settings.copy.workspaces.disconnectTitle", {
                          folder: fileSourceName(folder.path),
                        }),
                        message: language.t("settings.copy.thisProjectWillLoseAccessToTheFolder"),
                        confirmLabel: language.t("settings.copy.disconnectFolder"),
                        danger: true,
                      })
                    }
                  />
                </Section>
              </>
            )
          }}
        </Show>
      </PanelBody>
    </PanelScroll>
  )
}

export default Workspaces
