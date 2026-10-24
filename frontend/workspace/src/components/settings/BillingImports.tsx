import { useLanguage } from "@/context/language"
import type { SettingsUsageImportsResponses, SettingsUsageBillingResponses } from "@synsci/sdk/v2/client"
import { createEffect, createSignal, For, Show, onCleanup } from "solid-js"
import { Button } from "@synsci/ui/button"
import { downloadBlob } from "@/artifacts/bytes"
import { settingsApi } from "./api"

type Batch = SettingsUsageImportsResponses[200][number]
type Record = SettingsUsageBillingResponses[200][number]

export function BillingImports(props: {
  base: string
  fetch: typeof fetch
  start: string
  end: string
  changed: () => void
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  const [batches, setBatches] = createSignal<Batch[]>([])
  const [records, setRecords] = createSignal<Record[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  createEffect(() => {
    if (!open()) return
    const controller = new AbortController()
    refresh()
    const range = new URLSearchParams({ start: props.start, end: props.end })
    setError("")
    void Promise.all([
      settingsApi<Batch[]>(props.base, props.fetch, "/settings/usage/imports", { signal: controller.signal }),
      settingsApi<Record[]>(props.base, props.fetch, `/settings/usage/billing?${range}`, { signal: controller.signal }),
    ])
      .then(([batches, records]) => {
        if (controller.signal.aborted) return
        setBatches(batches)
        setRecords(records)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(language.t("settings.copy.couldNotReadBillingImportsPleaseRetry"))
      })
    onCleanup(() => controller.abort())
  })
  const mutate = async (init: RequestInit, suffix = "") => {
    if (busy()) return
    setBusy(true)
    setError("")
    await settingsApi(props.base, props.fetch, `/settings/usage/imports${suffix}`, init)
      .then(() => {
        setRefresh((value) => value + 1)
        props.changed()
      })
      .catch(() => setError(language.t("settings.copy.importCouldNotBeSavedOrRemovedCheck")))
      .finally(() => setBusy(false))
  }
  const importFile = async (file?: File) => {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError(language.t("settings.copy.chooseAJsonFileNoLargerThan2"))
      return
    }
    const document: unknown = await file
      .text()
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    if (!document) {
      setError(language.t("settings.copy.chooseAValidJsonBillingDocument"))
      return
    }
    await mutate({ method: "POST", body: JSON.stringify(document) })
  }
  const template = () =>
    downloadBlob(
      "openscience-provider-billing-template.json",
      new Blob(
        [
          JSON.stringify(
            {
              schema_version: 1,
              provider: "openai",
              account_label: "Provider account label",
              currency: "USD",
              records: [
                {
                  billing_id: "replace-with-provider-billing-line-id",
                  kind: "charge",
                  provider_request_id: "replace-with-provider-request-id",
                  occurred_at: new Date().toISOString(),
                  model: "replace-with-model-id",
                  amount_usd: "0.012345",
                },
              ],
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    )
  return (
    <section class="usage-export" aria-label={language.t("settings.copy.providerBillingImports")}>
      <div>
        <strong>{language.t("settings.copy.providerBillingImports")}</strong>
        <p>{language.t("settings.copy.importNormalizedJsonBillingEvidenceFilesStayOn")}</p>
        <Button size="small" variant="secondary" onClick={() => setOpen(!open())}>
          {open() ? language.t("settings.copy.hideBillingImports") : language.t("settings.copy.manageBillingImports")}
        </Button>
        <Show when={open()}>
          <p>{language.t("settings.copy.useTheTemplateToConvertProviderExportsStable")}</p>
          <Button size="small" variant="secondary" onClick={template}>
            {language.t("settings.copy.downloadBillingTemplate")}
          </Button>
          <label>
            {language.t("settings.copy.importBillingJson")}{" "}
            <input
              aria-label={language.t("settings.copy.importBillingJson")}
              type="file"
              accept=".json,application/json"
              disabled={busy()}
              onChange={(event) => {
                void importFile(event.currentTarget.files?.[0])
                event.currentTarget.value = ""
              }}
            />
          </label>
          <p>{language.t("settings.copy.matchingUsesExactProviderRequestIdsAndUnique")}</p>
          <p>
            {language.t("settings.copy.selectedDates")}
            {records().filter((record) => record.match === "matched").length} {language.t("settings.copy.matched")}{" "}
            {records().filter((record) => record.match === "unmatched").length} {language.t("settings.copy.unmatched")}{" "}
            {records().filter((record) => record.match === "ambiguous").length}{" "}
            {language.t("settings.copy.ambiguousBillingRecords")}
          </p>
          <Button
            size="small"
            variant="secondary"
            disabled={!records().length}
            onClick={() =>
              downloadBlob(
                "openscience-billing-reconciliation.json",
                new Blob([JSON.stringify(records(), null, 2)], { type: "application/json" }),
              )
            }
          >
            {language.t("settings.copy.exportBillingReconciliation")}
          </Button>
          <For each={batches()}>
            {(batch) => (
              <p>
                {batch.provider} · {batch.accountLabel} · {batch.records} {language.t("settings.copy.records")}{" "}
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy()}
                  aria-label={`Remove import ${batch.id}`}
                  onClick={() => mutate({ method: "DELETE" }, `/${batch.id}`)}
                >
                  {language.t("settings.copy.removeImport")}
                </Button>
              </p>
            )}
          </For>
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </div>
    </section>
  )
}
