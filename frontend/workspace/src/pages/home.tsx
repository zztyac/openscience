import { useLanguage } from "@/context/language"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { CommandPalette } from "@/atlas/CommandPalette"
import { DisconnectedPanel } from "@/atlas/DisconnectedPanel"
import { FdaBanner } from "@/atlas/FdaBanner"
import { FolderPicker } from "@/atlas/FolderPicker"
import { HelpOverlay } from "@/atlas/HelpOverlay"
import { confirmDialog } from "@/atlas/dialogs"
import { uiStore } from "@/atlas/store/ui"
import { projectPrefs } from "@/atlas/store/projectPrefs"
import { ToastContainer } from "@/atlas/Toast"
import { useGlobalKeys } from "@/atlas/useGlobalKeys"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DialogCreateProject, type ProjectCreateInput } from "@/components/dialog-create-project"
import { DialogSettings } from "@/components/dialog-settings"
import { settingsApi } from "@/components/settings/api"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { ProjectsWorkbench, type HomeProject } from "./home-workbench"
import {
  filterProjects,
  launcherState,
  prepareArchivedProjects,
  prepareProjects,
  projectName,
  type ProjectRecord,
} from "./home-projects"
import { localPathPlatform } from "@/utils/local-path"
import { projectHref } from "@/utils/project-route"
import { NativeDirectoryPickerUnavailable } from "@/utils/native-picker"

export default function Home(): JSX.Element {
  const language = useLanguage()
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const server = useServer()
  const commands = useCommand()
  const [query, setQuery] = createSignal("")
  const [draft, setDraft] = createSignal({ name: "", sources: [] as string[] })
  const projects = createMemo(() =>
    prepareProjects(sync.data.project, projectPrefs.hidden(), projectPrefs.favorites()).map((project): HomeProject => {
      const child = sync.child(project.worktree, { bootstrap: false, projectID: project.id })[0]
      if (child.status !== "complete") return project
      return { ...project, sessions: child.sessionTotal }
    }),
  )
  const archivedProjects = createMemo(() => prepareArchivedProjects(sync.data.project))
  const filtered = createMemo(() => filterProjects(projects(), query()))
  const state = createMemo(() =>
    launcherState({
      ready: sync.ready,
      healthy: server.healthy(),
      error: sync.error,
      projectCount: projects().length + archivedProjects().length,
    }),
  )
  const status = createMemo(() => {
    if (server.healthy() === true) return "healthy"
    if (server.healthy() === false) return "error"
    return "checking"
  })

  function openProject(project: ProjectRecord) {
    projectPrefs.unhide(project.id, project.worktree)
    layout.projects.open(project.worktree)
    server.projects.touch(project.id)
    navigate(projectHref(project))
  }

  function pinProject(project: ProjectRecord) {
    projectPrefs.toggleFavorite(project.id, project.worktree)
  }

  async function archiveProject(project: ProjectRecord) {
    const name = projectName(project)
    const ok = await confirmDialog(dialog, {
      title: language.t("pages.copy.archiveNamedQuestion", { name }),
      message: language.t("pages.copy.archiveProjectHint"),
      confirmLabel: language.t("common.archive"),
    })
    if (!ok) return
    try {
      await settingsApi<ProjectRecord>(sdk.url, platform.fetch ?? fetch, `/project/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      })
      projectPrefs.hide(project.id, project.worktree)
      layout.projects.close(project.worktree)
      showToast({ variant: "success", title: language.t("pages.copy.projectArchived") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("pages.copy.archiveProjectFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function restoreProject(project: ProjectRecord) {
    try {
      await settingsApi<ProjectRecord>(sdk.url, platform.fetch ?? fetch, `/project/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: false }),
      })
      projectPrefs.unhide(project.id, project.worktree)
      showToast({ variant: "success", title: language.t("pages.copy.restoredNamed", { name: projectName(project) }) })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("pages.copy.restoreProjectFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function createProject(input: ProjectCreateInput) {
    const project = await settingsApi<ProjectRecord>(sdk.url, platform.fetch ?? fetch, "/global/project", {
      method: "POST",
      body: JSON.stringify(input),
    })
    setDraft({ name: "", sources: [] })
    openProject(project)
  }

  const mergeSources = (result: string | string[] | null) => {
    const paths = Array.isArray(result) ? result : result ? [result] : []
    if (paths.length === 0) return
    setDraft((current) => ({
      ...current,
      sources: [...new Set([...current.sources, ...paths])].slice(0, 10),
    }))
  }

  async function chooseProjectSources() {
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform
        .openDirectoryPickerDialog({
          title: language.t("pages.copy.addSourceFolders"),
          multiple: true,
          serverUrl: sdk.url,
        })
        .catch((error) => {
          if (!(error instanceof NativeDirectoryPickerUnavailable)) {
            showToast({
              title: language.t("pages.copy.folderPickerFailed"),
              description: error instanceof Error ? error.message : String(error),
            })
          }
          return undefined
        })
      if (result !== undefined) {
        mergeSources(result)
        return
      }
    }

    const selection = { result: null as string | string[] | null }
    dialog.show(
      () => (
        <FolderPicker
          multiple
          title={language.t("pages.copy.addSourceFolder")}
          onSelect={(value) => (selection.result = value)}
        />
      ),
      {
        onClose: () => {
          mergeSources(selection.result)
          resumeCreateProject()
        },
      },
    )
  }

  function createDialog() {
    return (
      <DialogCreateProject
        name={draft().name}
        sources={draft().sources}
        // The system folder dialog opens on the server's machine, so only a local server has one to name.
        os={platform.openDirectoryPickerDialog && server.isLocal() ? localPathPlatform(sync.data.path.home) : undefined}
        onDraft={(name) => setDraft((current) => ({ ...current, name }))}
        onChooseSources={() => void chooseProjectSources()}
        onRemoveSource={(path) =>
          setDraft((current) => ({ ...current, sources: current.sources.filter((source) => source !== path) }))
        }
        onCreate={createProject}
      />
    )
  }

  function resumeCreateProject() {
    dialog.show(createDialog)
  }

  function showCreateProject() {
    setDraft({ name: "", sources: [] })
    dialog.show(createDialog)
  }

  commands.register(() => [
    {
      id: "project.create",
      title: language.t("pages.copy.createProject"),
      description: language.t("pages.copy.createProjectHint"),
      category: language.t("pages.copy.projects"),
      onSelect: showCreateProject,
    },
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      description: language.t("pages.copy.openSettingsHint"),
      category: language.t("pages.copy.application"),
      onSelect: () => dialog.show(() => <DialogSettings />),
    },
    {
      id: "server.switch",
      title: language.t("command.server.switch"),
      description: language.t("pages.copy.switchServerHint"),
      category: language.t("pages.copy.application"),
      onSelect: () => dialog.show(() => <DialogSelectServer />),
    },
  ])

  useGlobalKeys({ onNew: showCreateProject })

  return (
    <div class="atlas-root science-home">
      <ToastContainer />
      <HelpOverlay open={uiStore.helpOpen()} onClose={() => uiStore.setHelpOpen(false)} />
      <CommandPalette open={uiStore.paletteOpen()} onClose={() => uiStore.setPaletteOpen(false)} />

      <ProjectsWorkbench
        state={state()}
        projects={filtered()}
        archivedProjects={archivedProjects()}
        totalProjects={projects().length}
        query={query()}
        refreshing={!sync.ready}
        accessory={<FdaBanner />}
        notice={
          <Show when={state() === "recent"}>
            <DisconnectedPanel />
          </Show>
        }
        serverName={server.name || language.t("pages.copy.localServer")}
        serverStatus={status()}
        onQuery={setQuery}
        onOpen={openProject}
        onPin={pinProject}
        onArchive={(project) => void archiveProject(project)}
        onRestore={(project) => void restoreProject(project)}
        onCreate={showCreateProject}
        onRetry={() => void server.refresh()}
        onSettings={() => dialog.show(() => <DialogSettings />)}
        onServer={() => dialog.show(() => <DialogSelectServer />)}
      />
    </div>
  )
}
