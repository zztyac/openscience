import { useLanguage } from "@/context/language"
// Permissions — the standing approvals granted from permission cards (project
// and machine scope, revocable here) plus the per-tool allow/ask/deny defaults
// the agent loop enforces (config `permission` key via the globalSync-backed
// component).
//
// The former "Registry actions" grant grid was removed deliberately: it
// persisted scopes to a JSON store that no backend path ever consulted, so the
// controls were display-only. Per the product truth pass, surfaces without a
// real end-to-end runtime path are removed rather than shown.
import { Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { resolveProjectRoute } from "@/utils/project-route"
import { PermissionToolDefaults } from "../settings-permissions"
import { PanelBody, PanelHeader, PanelScroll, Section, steady } from "./_shared"
import { UsageLogging } from "./UsageLogging"
import { useSettingsNav } from "./nav"
import "./preference-panels.css"

interface StandingApproval {
  id: string
  permission: string
  pattern: string
  scope: "project" | "global"
  created: number
}

interface FolderGrant {
  id: string
  path: string
  access: "read" | "write"
  scope: "once" | "session" | "project" | "installation"
  source: "permission" | "api"
  time: { created: number }
}

/** What a standing approval covers, in the words the card used. A Modal
 * approval on a 64-hex plan digest covers one exact job and nothing else; an
 * allowance covers Modal jobs up to a total of job time; a study pattern
 * covers that study's runs. */
function approvalTitle(approval: { permission: string; pattern: string }) {
  if (approval.permission === "modal") {
    if (/^allowance:\d+$/.test(approval.pattern)) return "Modal jobs"
    if (approval.pattern.startsWith("study:")) return "Study runs on Modal"
    if (/^[a-f0-9]{64}$/.test(approval.pattern)) return "One exact Modal job"
    return "Modal"
  }
  if (approval.permission === "environment_mutation") return "One exact environment change"
  return approval.permission
}

function approvalDetail(approval: { permission: string; pattern: string }) {
  if (approval.pattern === "*") return undefined
  if (approval.permission === "modal") {
    const allowance = /^allowance:(\d+)$/.exec(approval.pattern)
    if (allowance) {
      const minutes = Number(allowance[1])
      return `up to ${minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`} of job time`
    }
    if (approval.pattern.startsWith("study:")) return approval.pattern.slice("study:".length)
    if (/^[a-f0-9]{64}$/.test(approval.pattern)) return `plan ${approval.pattern.slice(0, 12)}`
  }
  if (approval.permission === "environment_mutation" && /^[a-f0-9]{64}$/.test(approval.pattern)) {
    return `plan ${approval.pattern.slice(0, 12)}`
  }
  return approval.pattern
}

const Permissions: Component = () => {
  const language = useLanguage()
  const params = useParams()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const navigate = useSettingsNav()
  const [busy, setBusy] = createSignal(false)
  const [showAllDefaults, setShowAllDefaults] = createSignal(false)

  const route = createMemo(() => resolveProjectRoute(params.dir, globalSync.data.project))

  const [standing, { refetch }] = steady(
    createResource(
      () => route()?.directory ?? false,
      async (directory) => {
        const response = await sdk.client.permission.standing.list({ directory })
        return (response.data ?? []) as StandingApproval[]
      },
    ),
  )

  const [trust, trustControls] = steady(
    createResource(
      () => {
        const value = route()
        if (!value) return
        return { projectID: value.projectID, directory: value.directory }
      },
      async (input) => {
        const response = await sdk.client.project.trust.get(input)
        if (!response.data) throw new Error(language.t("settings.copy.projectTrustStatusWasEmpty"))
        return response.data
      },
    ),
  )

  const [folders, folderControls] = steady(
    createResource(
      () => {
        const value = route()
        const sessionID = params.id
        if (!value) return
        return { sessionID: sessionID && sessionID !== "new" ? sessionID : undefined, directory: value.directory }
      },
      async (input) => {
        const response = input.sessionID
          ? await sdk.client.session.filesystem.list({ ...input, sessionID: input.sessionID })
          : await sdk.client.project.filesystem.list({ directory: input.directory })
        return (response.data?.grants ?? []).filter(
          (grant): grant is FolderGrant =>
            (grant.source === "permission" || grant.source === "api") && !grant.time.consumed && !grant.time.revoked,
        )
      },
    ),
  )

  const revoke = async (approval: StandingApproval) => {
    const directory = route()?.directory
    if (!directory) return
    setBusy(true)
    try {
      await sdk.client.permission.standing.revoke({ id: approval.id, directory })
      await refetch()
    } catch (err) {
      showToast({
        title: language.t("settings.copy.failedToRevokeApproval"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const when = (created: number) => new Date(created).toLocaleDateString()

  const revokeFolder = async (grant: FolderGrant) => {
    const value = route()
    const sessionID = params.id ?? ""
    if (!value || busy() || (grant.scope !== "project" && (!sessionID || sessionID === "new"))) return
    const confirmed = await confirmDialog(dialog, {
      title: `Revoke access to ${grant.path}?`,
      message: language.t("settings.copy.openscienceWillStopAffectedKernelsSoTheFolder"),
      confirmLabel: language.t("settings.copy.revokeFolderAccess"),
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    await (
      grant.scope === "project"
        ? sdk.client.project.filesystem.revoke({ grantID: grant.id, directory: value.directory })
        : sdk.client.session.filesystem.revoke({ sessionID, grantID: grant.id, directory: value.directory })
    )
      .then(() => folderControls.refetch())
      .catch((error) =>
        showToast({
          title: language.t("settings.copy.failedToRevokeFolderAccess"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setBusy(false))
  }

  const updateTrust = async (trusted: boolean) => {
    const value = route()
    const status = trust()
    if (!value || !status || busy()) return
    const confirmed = await confirmDialog(dialog, {
      title: trusted ? language.t("settings.copy.trustThisProject") : language.t("settings.copy.revokeProjectTrust"),
      message: trusted
        ? `Allow project-owned code under ${status.root}, including plugins, MCP servers, formatters, language servers, provider commands, and startup hooks. Trust also permits remote jobs, kernel environment changes such as package installs, and host execution when the sandbox is off or explicitly configured to fall back without containment. Sandboxed terminals, kernels, and local jobs do not require project trust unless you enable that stricter policy in Sandbox settings.`
        : language.t("settings.copy.remoteJobsKernelEnvironmentChangesSuchAsPackage"),
      confirmLabel: trusted ? language.t("settings.copy.trustProject") : language.t("settings.copy.revokeTrust"),
      danger: !trusted,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await sdk.client.project.trust.update({
        projectID: value.projectID,
        directory: value.directory,
        body: trusted ? { trusted: true, root: status.root } : { trusted: false },
      })
      await trustControls.refetch()
      showToast({
        variant: "success",
        title: trusted ? language.t("settings.copy.projectTrusted") : language.t("settings.copy.projectTrustRevoked"),
      })
    } catch (error) {
      showToast({
        title: trusted
          ? language.t("settings.copy.couldNotTrustProject")
          : language.t("settings.copy.couldNotRevokeProjectTrust"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--permissions">
        <PanelHeader
          title={language.t("settings.shell.panel.permissions")}
          description={language.t("settings.copy.controlProjectTrustApprovalsAndToolBehavior")}
        />
        <PanelBody>
          <Show when={route()}>
            <Section
              title={language.t("settings.copy.projectCode")}
              description={language.t("settings.copy.trustRemoteJobsKernelEnvironmentChangesProjectOwned")}
            >
              <div class="settings-card settings-preferences-card">
                <Show
                  when={!trust.loading}
                  fallback={
                    <div
                      class="settings-panel-loading__rows"
                      role="status"
                      aria-label={language.t("settings.copy.checkingProjectTrust")}
                    >
                      <span />
                    </div>
                  }
                >
                  <Show
                    when={!trust.error}
                    fallback={
                      <div class="settings-alert" data-tone="critical" role="alert">
                        <span>
                          {language.t("settings.copy.projectTrustCouldNotBeLoaded")}
                          {String(trust.error)}
                        </span>
                        <Button
                          size="small"
                          variant="secondary"
                          class="settings-panel-action"
                          onClick={() => void trustControls.refetch()}
                        >
                          {language.t("settings.connectors.retry")}
                        </Button>
                      </div>
                    }
                  >
                    <div class="settings-row settings-preference-row justify-between">
                      <div class="settings-row-copy">
                        <strong>
                          {trust()?.canExecuteProjectCode
                            ? language.t("settings.copy.projectCodeEnabled")
                            : language.t("settings.copy.projectExtensionsBlocked")}
                        </strong>
                        <span class="break-all">{trust()?.root}</span>
                      </div>
                      <span
                        class="settings-preference-status"
                        data-tone={trust()?.canExecuteProjectCode ? "success" : "warning"}
                      >
                        {trust()?.canExecuteProjectCode
                          ? language.t("settings.copy.trusted")
                          : language.t("settings.copy.restricted")}
                      </span>
                      <Button
                        size="small"
                        variant={trust()?.canExecuteProjectCode ? "ghost" : "secondary"}
                        disabled={busy() || !trust()}
                        onClick={() => void updateTrust(!trust()?.canExecuteProjectCode)}
                      >
                        {trust()?.canExecuteProjectCode
                          ? language.t("settings.copy.revokeTrust")
                          : language.t("settings.copy.trustProject")}
                      </Button>
                    </div>
                  </Show>
                </Show>
              </div>
            </Section>
          </Show>

          <Show when={route()}>
            <Section
              title={language.t("settings.copy.connectedFolders")}
              description={language.t("settings.copy.reviewFolderAccessForThisProjectAddFolders")}
            >
              <div class="settings-card settings-preferences-card">
                <Show
                  when={!folders.loading}
                  fallback={
                    <div
                      class="settings-panel-loading__rows"
                      role="status"
                      aria-label={language.t("settings.copy.loadingConnectedFolders")}
                    >
                      <span />
                    </div>
                  }
                >
                  <Show
                    when={!folders.error}
                    fallback={
                      <div class="settings-alert" data-tone="critical" role="alert">
                        <span>{language.t("settings.copy.connectedFoldersCouldNotBeLoaded")}</span>
                        <Button
                          size="small"
                          variant="secondary"
                          class="settings-panel-action"
                          onClick={() => void folderControls.refetch()}
                        >
                          {language.t("settings.connectors.retry")}
                        </Button>
                      </div>
                    }
                  >
                    <Show
                      when={(folders() ?? []).length > 0}
                      fallback={
                        <p class="settings-card-empty" role="status">
                          {language.t("settings.copy.noConnectedFoldersInThisProject")}
                        </p>
                      }
                    >
                      <For each={folders()}>
                        {(grant) => (
                          <div class="settings-row settings-preference-row justify-between">
                            <div class="settings-row-copy">
                              <strong class="break-all">{grant.path}</strong>
                              <span class="text-12-regular text-text-weak">
                                {grant.access === "write"
                                  ? language.t("settings.copy.readWrite")
                                  : language.t("settings.copy.readOnly")}{" "}
                                ·{" "}
                                {grant.scope === "installation"
                                  ? language.t("settings.copy.everyProject")
                                  : grant.scope === "project"
                                    ? language.t("settings.copy.thisProject")
                                    : language.t("settings.copy.thisSession")}
                              </span>
                            </div>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={busy()}
                              onClick={() => void revokeFolder(grant)}
                            >
                              {language.t("settings.copy.revoke")}
                            </Button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                </Show>
              </div>
              <Button variant="secondary" onClick={() => navigate("workspaces")}>
                {language.t("settings.copy.manageWorkspaceFolders")}
              </Button>
            </Section>
          </Show>

          {/* ── Standing approvals ── */}
          <Show when={route()}>
            <Section
              title={language.t("settings.copy.standingApprovals")}
              description={language.t("settings.copy.approvalsGrantedForThisProjectOrEveryProject")}
            >
              <div class="settings-card settings-preferences-card">
                <Show
                  when={!standing.loading}
                  fallback={
                    <div
                      class="settings-panel-loading__rows"
                      role="status"
                      aria-label={language.t("settings.copy.loadingStandingApprovals")}
                    >
                      <span />
                      <span />
                    </div>
                  }
                >
                  <Show
                    when={!standing.error}
                    fallback={
                      <div class="settings-alert" data-tone="critical" role="alert">
                        <span>
                          {language.t("settings.copy.standingApprovalsCouldNotBeLoaded")}
                          {String(standing.error)}
                        </span>
                        <Button
                          size="small"
                          variant="secondary"
                          class="settings-panel-action"
                          disabled={standing.loading}
                          onClick={() => void refetch()}
                        >
                          {language.t("settings.connectors.retry")}
                        </Button>
                      </div>
                    }
                  >
                    <Show
                      when={(standing() ?? []).length > 0}
                      fallback={
                        <p class="settings-card-empty" role="status">
                          {language.t("settings.copy.noStandingApprovalsYetConversationScopedApprovalsEnd")}
                        </p>
                      }
                    >
                      <For each={standing()}>
                        {(approval) => (
                          <div class="settings-row settings-preference-row justify-between">
                            <div class="settings-row-copy">
                              <strong class="break-all">
                                {approvalTitle(approval)}
                                <Show when={approvalDetail(approval)}>
                                  {(detail) => <span class="text-text-weak font-normal"> · {detail()}</span>}
                                </Show>
                              </strong>
                              <span class="text-12-regular text-text-weak">
                                {approval.scope === "global"
                                  ? language.t("settings.copy.everywhere")
                                  : language.t("settings.copy.thisProject")}{" "}
                                {language.t("settings.copy.granted")} {when(approval.created)}
                              </span>
                            </div>
                            <span class="ml-auto shrink-0">
                              <Button
                                size="small"
                                variant="ghost"
                                disabled={busy()}
                                onClick={() => void revoke(approval)}
                              >
                                {language.t("settings.copy.revoke")}
                              </Button>
                            </span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                </Show>
              </div>
            </Section>
          </Show>

          {/* Tool defaults are a long list, so keep the most common controls visible first. */}
          <div
            id="permission-tool-defaults"
            class="settings-permission-defaults settings-disclosure-group"
            data-expanded={showAllDefaults() ? "true" : "false"}
          >
            <PermissionToolDefaults />
            <div class="settings-disclosure-footer">
              <button
                type="button"
                class="settings-preference-action"
                data-variant="quiet"
                aria-expanded={showAllDefaults()}
                aria-controls="permission-tool-defaults"
                onClick={() => setShowAllDefaults((value) => !value)}
              >
                <Icon
                  name="chevron-down"
                  size="small"
                  classList={{ "rotate-180": showAllDefaults() }}
                  aria-hidden="true"
                />
                {showAllDefaults()
                  ? language.t("settings.copy.showFewerToolDefaults")
                  : language.t("settings.copy.showAllToolDefaults")}
              </button>
            </div>
          </div>
          <UsageLogging />
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

export default Permissions
