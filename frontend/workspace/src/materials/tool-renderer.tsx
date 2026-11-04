import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { BasicTool } from "@synsci/ui/basic-tool"
import { ToolRegistry, type ToolProps } from "@synsci/ui/message-part"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { MaterialSessionCard } from "./session-card"
import { materialText, type MaterialText } from "./i18n"
import { materialRequest } from "./files"
import { uiStore } from "@/atlas/store/ui"
import { normalizeStoredArtifact } from "@/artifacts/store"
import { normalizeFilePath } from "@/atlas/file-sources"
import type { MaterialLibrarySnapshot } from "@synsci/util/materials"
import type { MaterialLibraryNavigation } from "./library"

export function MaterialsTool(props: ToolProps) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore({ expanded: false })
  const t = (key: MaterialText) => materialText(language.locale(), key)
  const id = () =>
    typeof props.metadata?.materialsProjectID === "string" &&
    /^mat_[a-f0-9]{32}$/.test(props.metadata.materialsProjectID)
      ? (props.metadata.materialsProjectID as string)
      : undefined
  const create = () => (props.metadata?.action ?? props.input?.action) === "create"
  const request = materialRequest(sdk.request)
  const assertOwner = (library: MaterialLibrarySnapshot) => {
    if (
      !library.projectID ||
      library.projectID !== sdk.projectID ||
      !library.directory ||
      normalizeFilePath(library.directory) !== normalizeFilePath(sdk.directory)
    )
      throw new Error(t("libraryProjectMismatch"))
  }
  const navigation: MaterialLibraryNavigation = {
    directory(library) {
      assertOwner(library)
      uiStore.openFiles({ directory: sdk.directory, path: library.root, source: "files", sessionID: library.sessionID })
    },
    file(library, file) {
      assertOwner(library)
      uiStore.openFile(sdk.directory, file.path, { scope: "auto", sessionID: library.sessionID })
    },
    results(library) {
      assertOwner(library)
      uiStore.openFiles({ directory: sdk.directory, source: "results", sessionID: library.sessionID })
    },
    async result(library, file) {
      assertOwner(library)
      if (!file.resultID) throw new Error(t("libraryResultUnavailable"))
      const server = sdk.url
      const response = await sdk.request(`/file/artifact-store/${encodeURIComponent(file.resultID)}`)
      const artifact = response.ok ? normalizeStoredArtifact(await response.json()) : undefined
      assertOwner(library)
      if (sdk.url !== server || !artifact || artifact.projectID !== library.projectID)
        throw new Error(t("libraryResultUnavailable"))
      uiStore.openSaved(artifact, file.resultVersionID)
    },
  }
  return (
    <BasicTool
      {...props}
      icon="atom"
      defaultOpen={create()}
      forceOpen={props.forceOpen || create()}
      trigger={{ title: t("researchRecord"), subtitle: create() ? undefined : props.title }}
    >
      <Show
        when={id()}
        fallback={
          <Show when={props.output}>
            <p class="materials-tool-summary">{props.output}</p>
          </Show>
        }
      >
        {(projectID) => (
          <Show
            when={create()}
            fallback={
              <div class="materials-tool-followup">
                <Show when={props.output}>
                  <p class="materials-tool-summary">{props.output}</p>
                </Show>
                <details onToggle={(event) => setState("expanded", event.currentTarget.open)}>
                  <summary>{t("openResearchRecord")}</summary>
                  <Show when={state.expanded}>
                    <MaterialSessionCard
                      projectID={projectID()}
                      request={request}
                      navigation={navigation}
                      t={t}
                      locale={language.locale()}
                    />
                  </Show>
                </details>
              </div>
            }
          >
            <MaterialSessionCard
              projectID={projectID()}
              request={request}
              navigation={navigation}
              t={t}
              locale={language.locale()}
            />
          </Show>
        )}
      </Show>
    </BasicTool>
  )
}

ToolRegistry.register({ name: "materials_workflow", render: MaterialsTool })
