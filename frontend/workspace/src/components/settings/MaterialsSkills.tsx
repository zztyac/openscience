import { For, Show, createMemo, createUniqueId, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  MaterialSkillSnapshot,
  type MaterialSkillName,
  type MaterialStage,
  materialStages,
} from "@synsci/util/materials"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"
import { SettingsApiError, settingsApi } from "./api"
import "./materials-skills.css"

type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  platform: Pick<ReturnType<typeof usePlatform>, "fetch">
}
const stageKeys = {
  intake: "settings.copy.materialSkills.intake",
  literature: "settings.copy.materialSkills.literature",
  strategies: "settings.copy.materialSkills.strategies",
  ideas: "settings.copy.materialSkills.ideas",
  protocol: "settings.copy.materialSkills.protocol",
  analysis: "settings.copy.materialSkills.analysis",
} as const
const descriptionKeys = {
  arxiv: "settings.copy.materialSkills.arxiv",
  deepxiv: "settings.copy.materialSkills.deepxiv",
  "exa-search": "settings.copy.materialSkills.exa",
  openalex: "settings.copy.materialSkills.openalex",
  "research-lit": "settings.copy.materialSkills.researchLit",
  "semantic-scholar": "settings.copy.materialSkills.semanticScholar",
} as const

export default function MaterialsSkills(props: { services?: Services } = {}) {
  const language = useLanguage()
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const id = createUniqueId()
  const [state, setState] = createStore({
    saved: undefined as MaterialSkillSnapshot | undefined,
    stages: undefined as MaterialSkillSnapshot["stages"] | undefined,
    loading: true,
    saving: false,
    error: "",
    conflict: false,
    success: false,
  })
  let controller: AbortController | undefined
  let alive = true
  onCleanup(() => {
    alive = false
    controller?.abort()
  })
  const canonical = (stages: MaterialSkillSnapshot["stages"] | undefined) =>
    JSON.stringify(materialStages.map((stage) => [...(stages?.[stage] ?? [])].sort()))
  const dirty = createMemo(() => !!state.saved && canonical(state.stages) !== canonical(state.saved.stages))
  const busy = () => state.loading || state.saving
  const request = async (init?: RequestInit) => {
    controller?.abort()
    controller = new AbortController()
    const result = await settingsApi<unknown>(sdk.url, platform.fetch ?? fetch, "/materials/skills", {
      ...init,
      signal: controller.signal,
    })
    const parsed = MaterialSkillSnapshot.safeParse(result)
    if (!parsed.success) throw new Error(language.t("settings.copy.materialSkills.invalidResponse"))
    return parsed.data
  }
  function apply(snapshot: MaterialSkillSnapshot) {
    setState("saved", reconcile(snapshot))
    setState("stages", reconcile(structuredClone(snapshot.stages)))
  }
  function fail(error: unknown) {
    const conflict = error instanceof SettingsApiError && error.status === 409
    setState({
      conflict,
      error: conflict
        ? language.t("settings.copy.materialSkills.conflict")
        : error instanceof SettingsApiError && error.status === 404
          ? language.t("settings.copy.materialSkills.unavailable")
          : error instanceof TypeError
            ? language.t("settings.copy.materialSkills.networkError")
            : error instanceof Error
              ? error.message
              : language.t("settings.copy.materialSkills.networkError"),
    })
  }
  async function load() {
    if (state.saving) return
    setState({ loading: true, error: "", success: false, conflict: false })
    try {
      const result = await request()
      if (alive) apply(result)
    } catch (error) {
      if (alive) fail(error)
    } finally {
      if (alive) setState("loading", false)
    }
  }
  async function save() {
    if (!state.saved || !state.stages || busy() || !dirty() || state.conflict) return
    setState({ saving: true, error: "", success: false })
    try {
      const result = await request({
        method: "POST",
        body: JSON.stringify({ revision: state.saved.revision, stages: state.stages }),
      })
      if (!alive) return
      apply(result)
      setState("success", true)
    } catch (error) {
      if (alive) fail(error)
    } finally {
      if (alive) setState("saving", false)
    }
  }
  function toggle(stage: MaterialStage, name: MaterialSkillName, checked: boolean) {
    if (!state.stages || busy()) return
    const names = state.stages[stage]
    setState("stages", stage, checked ? [...new Set([...names, name])].sort() : names.filter((item) => item !== name))
    setState("success", false)
  }
  const catalog = (stage: MaterialStage) => [
    ...(state.saved?.catalog ?? []),
    ...(state.stages?.[stage] ?? [])
      .filter((name) => !state.saved?.catalog.some((item) => item.name === name))
      .map((name) => ({
        name,
        description: "",
        available: false,
        reason: language.t("settings.copy.materialSkills.missing"),
      })),
  ]
  onMount(() => void load())
  return (
    <PanelScroll>
      <PanelHeader
        title={language.t("settings.copy.materialSkills.title")}
        description={language.t("settings.copy.materialSkills.description")}
      />
      <PanelBody>
        <div class="materials-skills" aria-busy={busy()}>
          <p class="materials-skills__hint">{language.t("settings.copy.materialSkills.timing")}</p>
          <Show when={state.error}>
            <div class="materials-skills__error" role="alert">
              {state.error}
            </div>
          </Show>
          <Show when={state.loading && !state.saved}>
            <p role="status">{language.t("settings.copy.loading")}</p>
          </Show>
          <Show when={state.saved}>
            <div class="materials-skills__stages">
              <For each={materialStages}>
                {(stage, index) => (
                  <details class="materials-skills__stage" open={stage === "literature"}>
                    <summary>
                      <span class="materials-skills__number" aria-hidden="true">
                        {index() + 1}
                      </span>
                      <strong>{language.t(stageKeys[stage])}</strong>
                      <span class="materials-skills__count">
                        {(state.stages?.[stage].length ?? 0) > 0
                          ? language.t("settings.copy.materialSkills.selected", {
                              count: state.stages?.[stage].length ?? 0,
                            })
                          : language.t("settings.copy.materialSkills.standard")}
                      </span>
                    </summary>
                    <fieldset disabled={busy()} aria-label={language.t(stageKeys[stage])}>
                      <For each={catalog(stage)}>
                        {(skill) => {
                          const selected = () => state.stages?.[stage].includes(skill.name) ?? false
                          const description = () => {
                            const key = descriptionKeys[skill.name as keyof typeof descriptionKeys]
                            return key ? language.t(key) : skill.description
                          }
                          const control = `${id}-${stage}-${skill.name}`
                          return (
                            <label
                              class="materials-skills__skill"
                              for={control}
                              data-unavailable={!skill.available ? "true" : undefined}
                            >
                              <input
                                id={control}
                                type="checkbox"
                                name={`${stage}:${skill.name}`}
                                checked={selected()}
                                disabled={!skill.available && !selected()}
                                aria-describedby={`${control}-description`}
                                onChange={(event) => toggle(stage, skill.name, event.currentTarget.checked)}
                              />
                              <span class="materials-skills__copy">
                                <strong>{skill.name}</strong>
                                <span id={`${control}-description`}>{description()}</span>
                                <Show when={!skill.available}>
                                  <span class="materials-skills__reason">
                                    {skill.reason || language.t("settings.copy.materialSkills.missing")}
                                  </span>
                                </Show>
                              </span>
                            </label>
                          )
                        }}
                      </For>
                    </fieldset>
                  </details>
                )}
              </For>
            </div>
          </Show>
          <div class="materials-skills__actions">
            <button
              type="button"
              class="settings-button"
              data-variant="primary"
              disabled={busy() || !dirty() || state.conflict}
              onClick={() => void save()}
            >
              {language.t(state.saving ? "settings.copy.saving2" : "settings.copy.materialSkills.save")}
            </button>
            <button
              type="button"
              class="settings-button"
              data-variant="ghost"
              disabled={busy()}
              onClick={() => void load()}
            >
              {language.t(dirty() || state.conflict ? "settings.copy.materialSkills.reload" : "settings.copy.refresh")}
            </button>
            <Show when={state.success}>
              <span role="status">{language.t("settings.copy.materialSkills.saved")}</span>
            </Show>
            <Show when={dirty() && !state.success}>
              <span>{language.t("settings.copy.materialSkills.unsaved")}</span>
            </Show>
          </div>
        </div>
      </PanelBody>
    </PanelScroll>
  )
}
