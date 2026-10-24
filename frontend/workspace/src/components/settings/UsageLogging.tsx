import { useLanguage } from "@/context/language"
import { Show, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { Card, Row, RowCopy, Section } from "./_shared"
import type { SettingsUsageLoggingGetResponses, SettingsUsageLoggingHealthResponses } from "@synsci/sdk/v2/client"
import { ServerLoggingHealth } from "./ServerLoggingHealth"
import { settingsApi } from "./api"

type Status = SettingsUsageLoggingGetResponses[200]

type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  platform: Pick<ReturnType<typeof usePlatform>, "fetch">
}

export function UsageLogging(props: { services?: Services } = {}) {
  const language = useLanguage()
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const [state, setState] = createStore<{ status?: Status; busy: boolean; error?: string; revision: number }>({
    busy: false,
    revision: 0,
  })
  const load = (enabled?: boolean) => {
    if (state.busy) return
    const revision = state.revision
    setState({ busy: true, error: undefined })
    void settingsApi<Status>(
      sdk.url,
      platform.fetch ?? fetch,
      "/settings/usage-logging",
      enabled === undefined ? undefined : { method: "PUT", body: JSON.stringify({ enabled }) },
    )
      .then((status) => {
        if (revision === state.revision) setState("status", reconcile(status))
      })
      .catch(() => {
        if (revision === state.revision)
          setState({ error: language.t("settings.copy.couldNotReadOrSaveTraceSharingPlease") })
      })
      .finally(() => {
        if (revision === state.revision) setState({ busy: false })
      })
  }
  const accountChanged = () => {
    setState({ revision: state.revision + 1, status: undefined, busy: false, error: undefined })
    load()
  }
  onMount(() => {
    load()
    window.addEventListener("openscience:account-changed", accountChanged)
  })
  onCleanup(() => window.removeEventListener("openscience:account-changed", accountChanged))

  return (
    <Section
      title={language.t("settings.copy.dataPrivacy")}
      description={language.t("settings.copy.controlSessionTraceSharingFromThisDevice")}
    >
      <Card>
        <Row>
          <RowCopy
            title={language.t("settings.copy.shareSessionTraces")}
            description={language.t("settings.copy.onByDefaultWhileSignedInSubjectTo")}
          />
          <Switch
            hideLabel
            checked={state.status?.enabled ?? false}
            disabled={!state.status || state.busy}
            onChange={load}
          >
            {language.t("settings.copy.shareSessionTraces")}
          </Switch>
        </Row>
        <Row>
          <RowCopy
            title={language.t("settings.copy.loggingHealth")}
            description={
              !state.status
                ? language.t("settings.copy.loading")
                : !state.status.enabled
                  ? language.t("settings.copy.sharingIsOffQueuedRecordsHaveBeenCleared")
                  : !state.status.signedIn
                    ? language.t("settings.copy.signInToShareTracesNoRecordsAre")
                    : `${state.status.queued} queued · ${state.status.delivered} acknowledged · ${state.status.quarantined} need attention`
            }
          />
          <button type="button" class="settings-preference-action" disabled={state.busy} onClick={() => load()}>
            {language.t("settings.copy.refresh")}
          </button>
        </Row>
        <Show when={state.status}>
          {(status) => (
            <>
              <Row>
                <RowCopy
                  title={language.t("settings.copy.lastAcknowledgement")}
                  description={
                    status().lastDelivery ?? language.t("settings.copy.noDeliveryHasBeenAcknowledgedOnThisDevice")
                  }
                />
              </Row>
              <Show when={status().oldestQueuedAt}>
                <Row>
                  <RowCopy
                    title={language.t("settings.copy.oldestQueuedRecord")}
                    description={`${status().oldestQueuedAt}${status().stalled ? " · waiting more than five minutes for acknowledgement" : ""}`}
                  />
                </Row>
              </Show>
              <Show when={status().lastAttempt}>
                {(attempt) => (
                  <Row>
                    <RowCopy
                      title={language.t("settings.copy.lastDeliveryAttempt")}
                      description={`${attempt().startedAt} · ${attempt().state}${attempt().httpStatus === undefined ? "" : ` · HTTP ${attempt().httpStatus}`} · ${attempt().deliveryID}`}
                    />
                  </Row>
                )}
              </Show>
              <Show when={status().rejection}>
                {(rejection) => (
                  <Row>
                    <RowCopy
                      title={language.t("settings.copy.latestRejectedRecord")}
                      description={`${rejection().eventID} · ${rejection().reason === "local_size_limit" ? language.t("settings.copy.recordExceedsTheDeliverySizeLimit") : /^http_[1-5][0-9]{2}$/.test(rejection().reason) ? `HTTP ${rejection().reason.slice(5)}` : language.t("settings.copy.reasonUnavailable")}`}
                    />
                  </Row>
                )}
              </Show>
              <Show when={status().quarantined > 0}>
                <Row>
                  <RowCopy
                    title={language.t("settings.copy.rejectedRecords")}
                    description={`${status().quarantined} rejected records are kept on this device and are not retried automatically. Turning off sharing discards queued and rejected records.`}
                  />
                </Row>
              </Show>
              <Row>
                <RowCopy
                  title={language.t("settings.copy.whatThisChecks")}
                  description={language.t("settings.copy.theseCountsDescribeTraceDeliveryFromThisDevice")}
                />
              </Row>
            </>
          )}
        </Show>
      </Card>
      <ServerLoggingHealth
        signedIn={state.status?.signedIn ?? false}
        queued={state.status?.queued ?? 0}
        quarantined={state.status?.quarantined ?? 0}
        check={() =>
          settingsApi<SettingsUsageLoggingHealthResponses[200]>(
            sdk.url,
            platform.fetch ?? fetch,
            "/settings/usage-logging/health",
          )
        }
      />
      <Show when={state.status?.error}>
        <p role="alert">{state.status?.error}</p>
      </Show>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
    </Section>
  )
}
