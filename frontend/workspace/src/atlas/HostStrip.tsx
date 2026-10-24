import { useLanguage } from "@/context/language"
import { createMemo, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { hostReading, type Capacity } from "@/atlas/host-instruments"
import { identify } from "@/atlas/poll-identity"
import { createKernelRouteRequester, kernelAPI } from "@/atlas/kernel-api"
import { IconCpu } from "@/atlas/shared/Icon"
import "@/atlas/HostStrip.css"

type HostStripProps = {
  request?: (path: string) => Promise<Response>
}

export function HostStrip(props: HostStripProps = {}): JSX.Element {
  const language = useLanguage()
  const request = props.request ?? useSDK().request
  const kernelRequest = createKernelRouteRequester(request)
  const client = identify()
  const [health, setHealth] = createSignal<"loading" | "available" | "unavailable">("loading")
  const load = () =>
    kernelRequest(kernelAPI.compute(client))
      .then((response) => (response.ok ? (response.json() as Promise<Capacity>) : undefined))
      .then((capacity) => {
        setHealth(capacity ? "available" : "unavailable")
        return capacity
      })
      .catch(() => {
        setHealth("unavailable")
        return undefined
      })
  const [data, api] = createResource(load)
  const reading = createMemo(() => hostReading(data.latest))
  const memoryTotal = createMemo(() =>
    reading().memory === "memory unavailable"
      ? language.t("research.compute.memoryUnavailable")
      : reading()
          .memory.replace(/^of /, "/ ")
          .replace(/ memory$/, ""),
  )
  const refresh = () => {
    if (document.hidden || data.loading) return
    void api.refetch()
  }
  const timer = setInterval(refresh, 2_500)
  document.addEventListener("visibilitychange", refresh)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", refresh)
  })

  return (
    <section
      class="host-strip"
      aria-label={language.t("research.compute.local")}
      data-testid="host-strip"
      data-health={health()}
    >
      <div class="host-strip__identity">
        <span class="host-strip__glyph" aria-hidden="true">
          <IconCpu size={16} strokeWidth={1.5} />
        </span>
        <div class="host-strip__copy">
          <strong>{language.t("research.compute.computer")}</strong>
          <span>
            {health() === "loading"
              ? language.t("research.compute.loading")
              : health() === "unavailable"
                ? language.t("research.compute.unavailableUsage")
                : language.t("research.compute.activityCounts", { active: reading().live, running: reading().running })}
          </span>
        </div>
      </div>

      <div class="host-strip__resources" aria-label={language.t("research.compute.localResources")}>
        <div class="host-strip__metric" data-host-tile="memory">
          <span class="host-strip__label">{language.t("research.compute.memory")}</span>
          <p>
            <strong class="host-strip__headline">{reading().headline}</strong>
            <span class="host-strip__total">{memoryTotal()}</span>
          </p>
          <Meter value={reading().memoryFill} />
        </div>
        <div class="host-strip__metric" data-host-tile="cpu">
          <span class="host-strip__label">CPU</span>
          <p>
            <strong class="host-strip__cores-value">
              {reading().cores.includes(" of ")
                ? language.t("research.compute.coresOf", {
                    used: reading().cores.split(" of ")[0],
                    total: reading().cores.split(" of ")[1],
                  })
                : reading().cores}
            </strong>
            <span class="host-strip__total">{language.t("research.compute.cores")}</span>
          </p>
          <Meter value={reading().cpuFill} />
        </div>
      </div>
      <span
        class="host-strip__health"
        aria-live="polite"
        aria-label={language.t(
          {
            loading: "research.compute.loading",
            available: "research.compute.available",
            unavailable: "research.compute.unavailableUsage",
          }[health()] as
            "research.compute.loading" | "research.compute.available" | "research.compute.unavailableUsage",
        )}
      />
    </section>
  )
}

function Meter(props: { value: number }): JSX.Element {
  return (
    <span class="host-strip__meter" role="presentation" aria-hidden="true">
      <i style={{ width: `${Math.round(props.value * 100)}%` }} />
    </span>
  )
}
