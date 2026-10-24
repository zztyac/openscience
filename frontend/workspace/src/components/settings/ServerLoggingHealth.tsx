import { useLanguage } from "@/context/language"
import { For, Show, createEffect, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { SettingsUsageLoggingHealthResponses } from "@synsci/sdk/v2/client"
import { Card, Row, RowCopy } from "./_shared"

type Result = SettingsUsageLoggingHealthResponses[200]
const reasons = {
  signed_out: "settings.copy.helper.signInToCheckServerEvidence",
  unsupported: "settings.copy.helper.thisServerDoesNotSupportLoggingHealthReports",
  unauthorized: "settings.copy.helper.theServerCouldNotAuthorizeThisAccountOr",
  server_unavailable: "settings.copy.helper.theServerCouldNotBeReachedOrDid",
  invalid_report: "settings.copy.helper.theServerReturnedAnUnreadableHealthReportTry",
  account_changed: "settings.copy.helper.theAccountOrWorkspaceChangedDuringThisCheck",
} as const
const labels = {
  missing_call_id: "settings.copy.helper.missingCallIds",
  missing_link: "settings.copy.helper.missingCallToHoldLinks",
  ambiguous_link: "settings.copy.helper.ambiguousCallToHoldLinks",
  missing_hold: "settings.copy.helper.missingHolds",
  hold_mismatch: "settings.copy.helper.holdIdentityMismatches",
  settled_missing_charge: "settings.copy.helper.settledHoldsWithoutCharges",
  duplicate_charge: "settings.copy.helper.duplicateCharges",
  token_mismatch: "settings.copy.helper.providerLedgerTokenEvidenceGapsOrMismatches",
  charge_amount_mismatch: "settings.copy.helper.holdLedgerChargeMismatches",
} as const
const summaries = {
  healthy: "settings.copy.helper.noDiscrepanciesFoundInTheStoredEvidenceChecked",
  attention: "settings.copy.helper.storedEvidenceNeedsAttentionReviewTheFindingsBelow",
  incomplete: "settings.copy.helper.someCallOutcomesTokenCountsOrSettlementEvidence",
  no_data: "settings.copy.helper.noStoredModelCallEvidenceFoundForThis",
} as const

export function ServerLoggingHealth(props: {
  signedIn: boolean
  queued: number
  quarantined: number
  check: () => Promise<Result>
}) {
  const language = useLanguage()
  const [state, setState] = createStore<{ result?: Result; busy: boolean; error?: string; revision: number }>({
    busy: false,
    revision: 0,
  })
  const clear = () => setState({ result: undefined, error: undefined, busy: false, revision: state.revision + 1 })
  createEffect(on(() => props.signedIn, clear, { defer: true }))
  onMount(() => window.addEventListener("openscience:account-changed", clear))
  onCleanup(() => window.removeEventListener("openscience:account-changed", clear))
  const check = async () => {
    if (state.busy || !props.signedIn) return
    const revision = state.revision
    setState({ busy: true, result: undefined, error: undefined })
    await props
      .check()
      .then((result) => {
        if (revision === state.revision) setState({ result })
      })
      .catch(() => {
        if (revision === state.revision)
          setState({ error: language.t("settings.copy.couldNotCheckServerLoggingHealthPleaseRetry") })
      })
      .finally(() => {
        if (revision === state.revision) setState({ busy: false })
      })
  }
  const report = () => (state.result?.state === "available" ? state.result.report : undefined)
  return (
    <Card>
      <Row>
        <RowCopy
          title={language.t("settings.copy.serverReconciliation")}
          description={
            state.error ??
            (state.busy
              ? language.t("settings.copy.checking")
              : !props.signedIn
                ? language.t(reasons.signed_out)
                : state.result?.state === "unavailable"
                  ? language.t(reasons[state.result.reason])
                  : report()
                    ? language.t(summaries[report()!.status])
                    : language.t("settings.copy.checkStoredEvidenceForThisAccountDeviceAnd"))
          }
        />
        <button
          type="button"
          class="settings-preference-action"
          disabled={state.busy || !props.signedIn}
          onClick={() => void check()}
        >
          {language.t("settings.copy.checkServer")}
        </button>
      </Row>
      <Show when={report()}>
        {(value) => (
          <>
            <Row>
              <RowCopy
                title={language.t("settings.copy.checkedWindow")}
                description={language.t("settings.copy.health.window", {
                  since: value().since,
                  until: value().until,
                  checked: value().checked_at,
                })}
              />
            </Row>
            <Row>
              <RowCopy
                title={language.t("settings.copy.deliveryReceipts")}
                description={language.t("settings.copy.health.receipts", {
                  deliveries: value().receipts.deliveries,
                  receiptOnly: value().receipts.receipt_only ?? language.t("settings.copy.unknown"),
                  replayed: value().receipts.replayed_only ?? language.t("settings.copy.unknown"),
                  anomalous: value().receipts.anomalous ?? language.t("settings.copy.unknown"),
                  orphaned: value().receipts.orphaned_events,
                })}
              />
            </Row>
            <Row>
              <RowCopy
                title={language.t("settings.copy.serverUsage")}
                description={language.t("settings.copy.health.usage", {
                  responses: value().usage.responses,
                  projected: value().usage.projected,
                  missing: value().usage.missing_projection,
                })}
              />
            </Row>
            <Row>
              <RowCopy
                title={language.t("settings.copy.httpAttempts")}
                description={
                  value().attempts
                    ? language.t("settings.copy.health.attempts", {
                        calls: value().attempts!.calls,
                        dispatched: value().attempts!.dispatched,
                        completed: value().attempts!.completed,
                        failed: value().attempts!.failed,
                        cancelled: value().attempts!.cancelled,
                        timedOut: value().attempts!.timed_out,
                        pending: value().attempts!.pending,
                        unclassified: value().attempts!.unclassified_requests,
                      })
                    : language.t("settings.copy.thisServerDoesNotReportPreResponseAttempt")
                }
              />
            </Row>
            <Row>
              <RowCopy
                title={language.t("settings.copy.unknownProviderFields")}
                description={language.t("settings.copy.health.fields", {
                  input: value().usage.unknown_input,
                  output: value().usage.unknown_output,
                  reasoning: value().usage.unknown_reasoning,
                  cacheRead: value().usage.unknown_cache_read,
                  cacheWrite: value().usage.unknown_cache_write,
                })}
              />
            </Row>
            <Row>
              <RowCopy
                title={language.t("settings.copy.aceSettlementEvidence")}
                description={language.t("settings.copy.health.settled", {
                  settled: value().managed.settled,
                  pending: value().managed.pending,
                  released: value().managed.not_charged,
                  unknown: value().managed.unknown_charge_amount,
                })}
              />
            </Row>
            <Show when={value().managed.attempts_without_response !== undefined}>
              <Row>
                <RowCopy
                  title={language.t("settings.copy.aceCallsWithoutResponses")}
                  description={language.t("settings.copy.health.noResponse", {
                    attempts: value().managed.attempts_without_response ?? language.t("settings.copy.unknown"),
                    unknown: value().managed.unknown_attempt_charge ?? 0,
                  })}
                />
              </Row>
            </Show>
            <For each={(Object.keys(labels) as Array<keyof typeof labels>).filter((key) => value().managed[key] > 0)}>
              {(key) => (
                <Row>
                  <RowCopy title={language.t(labels[key])} description={String(value().managed[key])} />
                </Row>
              )}
            </For>
            <Show when={props.queued + props.quarantined > 0}>
              <Row>
                <RowCopy
                  title={language.t("settings.copy.stillOnThisDevice")}
                  description={language.t("settings.copy.health.queue", {
                    queued: props.queued,
                    rejected: props.quarantined,
                  })}
                />
              </Row>
            </Show>
          </>
        )}
      </Show>
    </Card>
  )
}
