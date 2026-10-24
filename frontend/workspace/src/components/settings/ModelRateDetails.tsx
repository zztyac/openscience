import { useLanguage } from "@/context/language"
import { For } from "solid-js"
import { modelPricing, pricingUpstream } from "@/context/model-pricing"

export function ModelRateDetails(
  props: Parameters<typeof modelPricing>[0] & {
    label: string
    provider: string
    limit: { context: number; output: number }
  },
) {
  const language = useLanguage()
  const pricing = () => modelPricing(props)
  return (
    <div class="models-rate-route">
      <strong class="text-12-medium text-text-base">
        {props.access === "managed" ? "Ace" : `${props.label} · ${pricingUpstream(props.pricing) ?? props.provider}`}
      </strong>
      <dl>
        <div>
          <dt>{language.t("command.category.context")}</dt>
          <dd>
            {props.limit.context.toLocaleString()} {language.t("settings.copy.tokens")}
          </dd>
        </div>
        <div>
          <dt>{language.t("settings.copy.maxOutput")}</dt>
          <dd>
            {props.limit.output.toLocaleString()} {language.t("settings.copy.tokens")}
          </dd>
        </div>
        <For each={pricing().lines}>
          {(line) => (
            <div>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          )}
        </For>
      </dl>
      <p>{pricing().note}</p>
    </div>
  )
}
