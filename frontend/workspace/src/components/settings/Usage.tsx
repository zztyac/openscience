import { useLanguage } from "@/context/language"
import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import {
  usageCostTotals,
  type UsageCost,
  usageCsv,
  usageDate,
  usageModels,
  usageRange,
  usageTotals,
  type UsageRow,
} from "@synsci/util/usage"
import { downloadBlob } from "@/artifacts/bytes"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"
import { BillingImports } from "./BillingImports"
import { settingsApi } from "./api"
import "./preference-panels.css"
import "./usage.css"

type Source = "managed" | "byok" | "local" | "subscription" | "unknown"
type Result = { connected: boolean; rows: UsageRow[] }
type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  platform: Pick<ReturnType<typeof usePlatform>, "fetch">
}
const sources = [
  { id: "managed", label: "settings.copy.usage.managed" },
  { id: "byok", label: "settings.copy.usage.keys" },
  { id: "local", label: "settings.shell.panel.local-models" },
  { id: "subscription", label: "settings.copy.usage.subscriptions" },
  { id: "unknown", label: "settings.copy.usage.unclassified" },
] as const
const number = (value: number) =>
  Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
const money = (value: number) =>
  value > 0 && value < 0.0001
    ? "<$0.0001"
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 })}`
const modelName = (value: string) => value.split("/").pop() ?? value

export default function Usage(props: { services?: Services } = {}) {
  const language = useLanguage()
  const dateName = (value: string) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString(language.locale() === "zht" ? "zh-Hant" : language.locale(), {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
  const costKeys = {
    wallet_receipt: "settings.copy.usage.wallet_receipt",
    provider_response: "settings.copy.usage.provider_response",
    catalog_estimate: "settings.copy.usage.catalog_estimate",
    imported_billing: "settings.copy.usage.imported_billing",
    imported_credit: "settings.copy.usage.imported_credit",
    wallet_calculated: "settings.copy.usage.wallet_calculated",
    recorded_unclassified: "settings.copy.usage.recorded_unclassified",
    subscription: "settings.copy.usage.subscription",
    no_provider_charge: "settings.copy.usage.no_provider_charge",
    unknown: "settings.copy.usage.unknown",
  } as const
  const costLabel = (source: UsageCost["source"]) => language.t(costKeys[source])
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const [state, setState] = createStore({
    ...usageRange(),
    source: "managed" as Source,
    model: "all",
    period: "30",
    basis: "catalog_estimate" as UsageCost["source"],
    metric: "tokens" as "tokens" | "cost" | "calls",
    active: "",
    refresh: 0,
    local: undefined as Result | undefined,
    managed: undefined as Result | undefined,
    loading: { local: false, managed: false },
    error: { local: "", managed: "" },
  })
  onMount(() => {
    const refresh = () => setState({ model: "all", refresh: state.refresh + 1 })
    window.addEventListener("openscience:account-changed", refresh)
    onCleanup(() => window.removeEventListener("openscience:account-changed", refresh))
  })
  const valid = createMemo(
    () =>
      usageDate(state.start) &&
      usageDate(state.end) &&
      state.start <= state.end &&
      (Date.parse(state.end) - Date.parse(state.start)) / 86_400_000 < 366,
  )
  createEffect(() => {
    const start = state.start
    const end = state.end
    state.refresh
    if (!valid()) return
    const controller = new AbortController()
    setState({ local: undefined, managed: undefined, active: "" })
    for (const source of ["local", "managed"] as const) {
      setState("loading", source, true)
      setState("error", source, "")
      void settingsApi<Result>(
        sdk.url,
        platform.fetch ?? fetch,
        `/settings/usage/${source}?${new URLSearchParams({ start, end })}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) setState(source, result)
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setState(
              "error",
              source,
              cause instanceof Error ? cause.message : language.t("settings.copy.usageCouldNotBeLoaded"),
            )
        })
        .finally(() => {
          if (!controller.signal.aborted) setState("loading", source, false)
        })
    }
    onCleanup(() => controller.abort())
  })
  const dataset = () => (state.source === "managed" ? "managed" : "local")
  const loading = () => state.loading[dataset()]
  const available = () => state[dataset()]
  const filtered = createMemo(() =>
    (available()?.rows ?? []).filter((row) =>
      state.source === "byok"
        ? row.route === "byok" || row.route === "custom"
        : state.source === "subscription"
          ? row.route === "subscription" || row.route === "chatgpt"
          : row.route === state.source,
    ),
  )
  const options = createMemo(() => [...new Set(filtered().map((row) => row.model))].sort())
  const rows = createMemo(() => filtered().filter((row) => state.model === "all" || row.model === state.model))
  const costs = createMemo(() => usageCostTotals(rows()))
  const costBasis = () => (state.source === "managed" ? "wallet_receipt" : state.basis)
  const exact = (value: string | null) => {
    if (value === null) return language.t("settings.copy.unknown")
    const [whole, fraction = ""] = value.split(".")
    return `$${whole}.${fraction.padEnd(2, "0")}`
  }
  const totals = createMemo(() => usageTotals(rows()))
  const models = createMemo(() => usageModels(rows()))
  const days = createMemo(() => {
    if (!valid()) return []
    const count = Math.round((Date.parse(state.end) - Date.parse(state.start)) / 86_400_000) + 1
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.parse(state.start) + index * 86_400_000).toISOString().slice(0, 10)
      const items = rows().filter((row) => row.date === date)
      const cost = usageCostTotals(items).find((cost) => cost.source === costBasis())
      return {
        date,
        ...usageTotals(items),
        cost: Number(cost?.amountUSD ?? 0),
        costKnown: (cost?.known ?? 0) > 0,
        costUnknown: cost?.unknown ?? 0,
      }
    })
  })
  const max = () => Math.max(Number.EPSILON, ...days().map((day) => day[state.metric]))
  const active = () => days().find((day) => day.date === state.active)
  const exportCsv = () => {
    if (loading() || !valid() || !rows().length) return
    downloadBlob(
      `openscience-${state.source}-usage-${state.start}-${state.end}.csv`,
      new Blob(["\uFEFF", usageCsv(rows())], { type: "text/csv;charset=utf-8" }),
    )
  }
  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-usage">
        <PanelHeader
          title={language.t("settings.shell.panel.usage")}
          description={language.t("settings.copy.trackModelActivityCostsAndTokens")}
          toolbar={
            <Button
              size="small"
              variant="secondary"
              disabled={loading() || !valid()}
              onClick={() => setState("refresh", (value) => value + 1)}
            >
              {language.t("settings.copy.refresh")}
            </Button>
          }
        />
        <PanelBody>
          <div class="usage-source-tabs" role="group" aria-label={language.t("settings.copy.usageSource")}>
            <For each={sources}>
              {(source) => (
                <button
                  type="button"
                  aria-pressed={state.source === source.id}
                  onClick={() => setState({ source: source.id, model: "all", active: "" })}
                >
                  {language.t(source.label)}
                </button>
              )}
            </For>
          </div>
          <div class="usage-controls">
            <label>
              {language.t("settings.copy.period")}
              <select
                value={state.period}
                onChange={(event) => {
                  const period = event.currentTarget.value
                  setState("period", period)
                  if (period !== "custom") setState(usageRange(Number(period)))
                }}
              >
                <option value="7">{language.t("settings.copy.last7Days")}</option>
                <option value="30">{language.t("settings.copy.last30Days")}</option>
                <option value="90">{language.t("settings.copy.last90Days")}</option>
                <option value="custom">{language.t("settings.copy.customDates")}</option>
              </select>
            </label>
            <label>
              {language.t("settings.copy.from")}
              <input
                type="date"
                aria-label={language.t("settings.copy.fromDate")}
                value={state.start}
                max={state.end}
                onInput={(event) => setState({ start: event.currentTarget.value, period: "custom" })}
              />
            </label>
            <label>
              {language.t("settings.copy.to")}
              <input
                type="date"
                aria-label={language.t("settings.copy.toDate")}
                value={state.end}
                min={state.start}
                onInput={(event) => setState({ end: event.currentTarget.value, period: "custom" })}
              />
            </label>
            <label>
              {language.t("command.category.model")}
              <select value={state.model} onChange={(event) => setState("model", event.currentTarget.value)}>
                <option value="all">{language.t("settings.copy.allModels")}</option>
                <For each={options()}>{(model) => <option value={model}>{modelName(model)}</option>}</For>
              </select>
            </label>
          </div>
          <Show when={!valid()}>
            <p class="settings-alert" data-tone="critical" role="alert">
              {language.t("settings.copy.chooseValidDatesInOrderSpanningNoMore")}
            </p>
          </Show>
          <p class="usage-scope">
            {state.source === "managed"
              ? language.t("settings.copy.yourConfirmedWalletChargesInTheSelectedFunding")
              : state.source === "unknown"
                ? language.t("settings.copy.olderActivityOnThisDeviceWithoutARecorded")
                : state.source === "local"
                  ? language.t("settings.copy.savedConversationActivityOnThisDeviceAcrossProjects")
                  : state.source === "subscription"
                    ? language.t("settings.copy.chatgptAndSubscriptionActivityOnThisDeviceSubscription")
                    : language.t("settings.copy.apiKeyActivityRecordedOnThisDeviceIncluding")}{" "}
            {language.t("settings.copy.datesUseUtcImportedBillingIncludesUnmatchedRecords")}
          </p>
          <Show when={state.error[dataset()]}>
            <div class="settings-alert" data-tone="critical" role="alert">
              {state.error[dataset()]}{" "}
              <button type="button" onClick={() => setState("refresh", (value) => value + 1)}>
                {language.t("settings.connectors.retry")}
              </button>
            </div>
          </Show>
          <Show when={valid() && !state.error[dataset()]}>
            <Show
              when={!loading()}
              fallback={
                <div class="usage-empty" role="status">
                  {language.t("settings.copy.loadingUsage")}
                </div>
              }
            >
              <Show
                when={available()?.connected !== false}
                fallback={
                  <div class="usage-empty">
                    {language.t("settings.copy.connectYourSyntheticSciencesAccountInAceTo")}
                  </div>
                }
              >
                <dl class="usage-totals">
                  <For each={costs()}>
                    {(cost) => (
                      <div>
                        <dt>{costLabel(cost.source)}</dt>
                        <dd>
                          {cost.source === "subscription"
                            ? language.t("settings.copy.notAllocated")
                            : exact(cost.amountUSD)}
                          {cost.unknown > 0 && cost.known > 0 ? " (partial)" : ""}
                        </dd>
                        <Show when={cost.unknown > 0 && cost.source !== "subscription"}>
                          <small>
                            {cost.unknown} {language.t("settings.copy.unknownCostObservations")}
                          </small>
                        </Show>
                      </div>
                    )}
                  </For>
                  <div>
                    <dt>{language.t("settings.copy.recordedTokens")}</dt>
                    <dd>{number(totals().tokens)}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.copy.requests")}</dt>
                    <dd>{totals().calls.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.copy.recordedCachedInput")}</dt>
                    <dd>{number(totals().cacheRead)}</dd>
                  </div>
                </dl>
                <section class="usage-chart" aria-label={language.t("settings.copy.dailyUsage")}>
                  <header>
                    <h3>{language.t("settings.copy.dailyActivity")}</h3>
                    <Show when={state.source !== "managed"}>
                      <label>
                        {language.t("settings.copy.costCategory")}{" "}
                        <select
                          aria-label={language.t("settings.copy.costCategory")}
                          value={state.basis}
                          onChange={(event) => setState("basis", event.currentTarget.value as UsageCost["source"])}
                        >
                          <For each={Object.entries(costKeys)}>
                            {([source, label]) => <option value={source}>{language.t(label)}</option>}
                          </For>
                        </select>
                      </label>
                    </Show>
                    <select
                      aria-label={language.t("settings.copy.chartMetric")}
                      value={state.metric}
                      onChange={(event) => setState("metric", event.currentTarget.value as typeof state.metric)}
                    >
                      <option value="tokens">{language.t("context.usage.tokens")}</option>
                      <option value="cost">{language.t("settings.copy.costKnownAmounts")}</option>
                      <option value="calls">{language.t("settings.copy.requests")}</option>
                    </select>
                  </header>
                  <div class="usage-chart-scroll">
                    <div
                      class="usage-bars"
                      style={{
                        "grid-template-columns": `repeat(${days().length}, minmax(5px, 1fr))`,
                        "min-width": `${days().length * 7}px`,
                      }}
                    >
                      <For each={days()}>
                        {(day) => (
                          <button
                            type="button"
                            aria-label={language.t("settings.copy.usage.dayLabel", {
                              date: day.date,
                              tokens: day.tokens.toLocaleString(),
                              calls: day.calls,
                              basis: costLabel(costBasis()),
                              cost: day.costKnown ? money(day.cost) : language.t("settings.copy.unknown"),
                              partial: day.costUnknown > 0 ? language.t("settings.copy.usage.partial") : "",
                            })}
                            aria-pressed={state.active === day.date}
                            onFocus={() => setState("active", day.date)}
                            onClick={() => setState("active", day.date)}
                            onMouseEnter={() => setState("active", day.date)}
                          >
                            <span
                              style={{
                                height: `${Math.max(day[state.metric] > 0 ? 2 : 0.5, (day[state.metric] / max()) * 100)}%`,
                              }}
                            />
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                  <div class="usage-axis">
                    <span>{dateName(state.start)}</span>
                    <span>{dateName(state.end)}</span>
                  </div>
                  <p class="usage-chart-detail" aria-live="polite">
                    {active()
                      ? language.t("settings.copy.usage.dayDetail", {
                          date: dateName(active()!.date),
                          tokens: number(active()!.tokens),
                          calls: active()!.calls,
                          basis: costLabel(costBasis()),
                          cost: active()!.costKnown ? money(active()!.cost) : language.t("settings.copy.unknown"),
                          partial: active()!.costUnknown > 0 ? language.t("settings.copy.usage.partial") : "",
                        })
                      : language.t("settings.copy.selectADayToSeeItsActivity")}
                  </p>
                </section>
                <section class="usage-models">
                  <h3>
                    {language.t("settings.copy.byModel")}
                    <span>{models().length}</span>
                  </h3>
                  <Show
                    when={models().length}
                    fallback={
                      <div class="usage-empty">{language.t("settings.copy.noActivityForTheseDatesAndFilters")}</div>
                    }
                  >
                    <div
                      class="usage-table-scroll"
                      role="region"
                      aria-label={language.t("settings.copy.modelUsage")}
                      tabIndex={0}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">{language.t("command.category.model")}</th>
                            <th scope="col">{language.t("settings.copy.requests")}</th>
                            <th scope="col">{language.t("settings.copy.recordedTokens")}</th>
                            <th scope="col">{language.t("context.usage.cost")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={models()}>
                            {(row) => (
                              <tr>
                                <td>
                                  <strong>{modelName(row.model)}</strong>
                                  <Show when={state.source !== "managed"}>
                                    <small>{row.provider}</small>
                                  </Show>
                                </td>
                                <td>{row.calls.toLocaleString()}</td>
                                <td>{number(row.tokens)}</td>
                                <td>
                                  <For each={usageCostTotals([row])}>
                                    {(cost) => (
                                      <div>
                                        {costLabel(cost.source)}:{" "}
                                        {cost.source === "subscription"
                                          ? language.t("settings.copy.notAllocated")
                                          : exact(cost.amountUSD)}
                                        {cost.unknown > 0 && cost.known > 0 ? " (partial)" : ""}
                                      </div>
                                    )}
                                  </For>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </section>
              </Show>
            </Show>
          </Show>
          <Show when={state.source === "byok" && valid()}>
            <BillingImports
              base={sdk.url}
              fetch={platform.fetch ?? fetch}
              start={state.start}
              end={state.end}
              changed={() => setState("refresh", (value) => value + 1)}
            />
          </Show>
          <footer class="usage-export">
            <div>
              <strong>{language.t("settings.copy.exportUsage")}</strong>
              <p>{language.t("settings.copy.dailyTotalsByModelForTheSelectedSource")}</p>
            </div>
            <Button
              size="small"
              variant="secondary"
              disabled={loading() || !valid() || !!state.error[dataset()] || !rows().length}
              onClick={exportCsv}
            >
              {language.t("settings.copy.exportCsv")}
            </Button>
          </footer>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
