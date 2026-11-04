import { createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  MaterialStage,
  MaterialSkillName,
  type MaterialActivity,
  type MaterialActivitySnapshot,
  type MaterialProject,
} from "@synsci/util/materials"
import type { MaterialText, Translator } from "./i18n"

const phases: Record<MaterialActivity["phase"], MaterialText> = {
  preparing: "activityPreparing",
  searching: "activitySearching",
  retrieving: "activityRetrieving",
  waiting: "activityWaiting",
  reasoning: "activityReasoning",
  generating: "activityGenerating",
  validating: "activityValidating",
  repairing: "activityRepairing",
  saving: "activitySaving",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
}
const roles: Record<string, MaterialText> = {
  intake: "roleIntake",
  "literature-search": "roleSearch",
  "fulltext-retrieval": "roleFulltext",
  "evidence-preparation": "roleEvidence",
  "strategy-builder": "roleStrategy",
  "strategies:reviewer": "roleStrategyReview",
  "idea-expert": "roleIdeas",
  "ideas:reviewer": "roleIdeaReview",
  "idea-proximity-ranking": "roleRanking",
  "idea-evolution": "roleEvolution",
  "idea-final-review": "roleFinalReview",
  protocol: "roleProtocol",
  "protocol:reviewer": "roleProtocolReview",
  analysis: "roleAnalysis",
}

export function activityRole(role: string | undefined, t: Translator) {
  if (!role) return ""
  if (role.startsWith("skill:")) {
    const skill = MaterialSkillName.safeParse(role.slice(6))
    return skill.success ? `${skill.data} · ${t("roleSkill")}` : ""
  }
  if (role.startsWith("skills:")) {
    const stage = MaterialStage.safeParse(role.slice(7))
    return stage.success ? `${t(stage.data)} · ${t("roleSkillExecution")}` : ""
  }
  const repair = role.endsWith(":repair")
  const key = roles[repair ? role.slice(0, -7) : role]
  return key ? `${t(key)}${repair ? ` · ${t("roleRepair")}` : ""}` : ""
}

function duration(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

/** Activity is observational: elapsed time and received characters are not a completion estimate. */
export function MaterialActivityPanel(props: {
  project: MaterialProject
  snapshot?: MaterialActivitySnapshot
  receivedAt?: number
  lastSuccessAt?: number
  connected: boolean
  legacy: boolean
  locale: string
  t: Translator
}) {
  const [clock, setClock] = createStore({ now: Date.now() })
  const timer = setInterval(() => setClock("now", Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  // A local cancellation can finish before an older poll. Keep its history,
  // while current state must come from a snapshot at least as new as the project.
  const fresh = () => props.snapshot && props.snapshot.revision >= props.project.revision
  const status = () => (fresh() ? props.snapshot!.status : props.project.status)
  // A resumed task can remain queued with the previous attempt's final activity.
  // Nothing from that attempt describes the operation waiting to start.
  const current = () => (fresh() && status() !== "queued" ? props.snapshot?.current : undefined)
  const active = () =>
    ["running", "queued"].includes(status()) &&
    !["completed", "failed", "cancelled", "interrupted"].includes(current()?.phase ?? "")
  const elapsed = createMemo(() => {
    const item = current()
    if (!item) return undefined
    const observed = props.snapshot!.serverTime
    const end = active()
      ? observed + (props.connected && props.receivedAt ? Math.max(0, clock.now - props.receivedAt) : 0)
      : item.updatedAt
    return duration(end - item.startedAt)
  })
  const stage = () =>
    status() === "queued"
      ? undefined
      : (current()?.stage ?? props.project.stages.find((step) => step.status === "running")?.key)
  const formatTime = (value: number) =>
    new Date(value).toLocaleTimeString(
      props.locale === "zh" ? "zh-CN" : props.locale === "zht" ? "zh-TW" : props.locale,
      {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      },
    )
  const modelActivity = () => current()?.lastModelActivityAt
  const events = createMemo(() => [...(props.snapshot?.events ?? [])].reverse())
  const hint = () => {
    if (!props.connected) return props.t("activityOfflineHint")
    if (props.legacy) return props.t("activityLegacy")
    if (status() === "queued") return props.t("activityQueuedHint")
    if (!current()) return props.t("activityNoDetail")
    if (!active()) return ""
    if (current()?.phase === "waiting" && !modelActivity()) return props.t("activityWaitingHint")
    if (current()?.phase === "reasoning") return props.t("activityReasoningHint")
    if (current()?.phase === "generating") return props.t("activityGeneratingHint")
    return ""
  }
  return (
    <section class="mat-activity" aria-label={props.t("activityTitle")} data-connected={props.connected}>
      <div class="mat-activity-heading">
        <div>
          <span class="mat-activity-label">{props.t("activityTitle")}</span>
          <h4 class="mat-activity-status" role="status" aria-live="polite">
            <Show when={stage()}>{(value) => <span>{props.t(value())} · </span>}</Show>
            {props.t(current() ? phases[current()!.phase] : status())}
          </h4>
        </div>
        <span class="mat-activity-connection" data-connected={props.connected}>
          {props.t(
            !props.connected ? (props.lastSuccessAt ? "activityOffline" : "activityConnecting") : "activityConnected",
          )}
        </span>
      </div>
      <Show when={activityRole(current()?.role, props.t)}>{(role) => <p class="mat-activity-role">{role()}</p>}</Show>
      <dl class="mat-activity-metrics">
        <Show when={current()?.step !== undefined && current()?.steps !== undefined}>
          <div>
            <dt>{props.t("activityOperation")}</dt>
            <dd data-field="operation">
              {current()!.step} / {current()!.steps}
            </dd>
          </div>
        </Show>
        <Show when={elapsed() !== undefined}>
          <div>
            <dt>{props.t("activityElapsed")}</dt>
            <dd data-field="elapsed">{elapsed()}</dd>
          </div>
        </Show>
        <div>
          <dt>{props.t("activityUpdated")}</dt>
          <dd data-field="updated">{props.lastSuccessAt ? formatTime(props.lastSuccessAt) : "—"}</dd>
        </div>
        <Show
          when={
            current()?.model ||
            modelActivity() ||
            ["waiting", "reasoning", "generating", "repairing"].includes(current()?.phase ?? "")
          }
        >
          <div>
            <dt>{props.t("activityModelSignal")}</dt>
            <dd data-field="model-activity">
              {modelActivity() ? formatTime(modelActivity()!) : props.t("activityNoModelSignal")}
            </dd>
          </div>
        </Show>
        <Show when={current()?.outputChars !== undefined}>
          <div>
            <dt>{props.t("activityOutput")}</dt>
            <dd data-field="output">{current()!.outputChars!.toLocaleString()}</dd>
          </div>
        </Show>
        <Show when={current()?.completed !== undefined && current()?.total !== undefined}>
          <div>
            <dt>{props.t("activityCount")}</dt>
            <dd data-field="sources">
              {current()!.completed} / {current()!.total}
            </dd>
          </div>
        </Show>
      </dl>
      <Show when={current()?.model}>
        <p class="mat-activity-model">
          {props.t("activityModel")} · {current()!.model}
        </p>
      </Show>
      <Show when={current()?.item}>
        <p class="mat-activity-item">{current()!.item}</p>
      </Show>
      <Show when={hint()}>{(value) => <p class="mat-activity-hint">{value()}</p>}</Show>
      <Show when={events().length}>
        <details class="mat-activity-history">
          <summary>
            {props.t("timeline")} · {events().length}
          </summary>
          <Show when={events().length >= 200}>
            <p class="mat-muted">{props.t("activityRecordLimit")}</p>
          </Show>
          <ol>
            <For each={events()}>
              {(event) => (
                <li>
                  <time dateTime={new Date(event.updatedAt).toISOString()}>{formatTime(event.updatedAt)}</time>
                  <div>
                    <strong>
                      {props.t(event.stage)} · {props.t(phases[event.phase])}
                    </strong>
                    <Show when={activityRole(event.role, props.t)}>
                      <span>{activityRole(event.role, props.t)}</span>
                    </Show>
                    <Show when={event.item}>
                      <span>{event.item}</span>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ol>
        </details>
      </Show>
    </section>
  )
}
