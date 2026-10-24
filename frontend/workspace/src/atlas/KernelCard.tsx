import { useLanguage } from "@/context/language"
import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { FileIcon } from "@synsci/ui/file-icon"
import { kernelLabel, kernelLanguageLabel, kernelMemoryLabel, type KernelStatus } from "@/atlas/kernel-runtime"

const age = (then: number | null, now: number) => {
  if (!then) return ""
  const seconds = Math.max(0, Math.floor((now - then) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const memory = (value?: number) => {
  const label = kernelMemoryLabel(value)
  return label === "Unavailable" ? "— RSS" : `${label} RSS`
}

const cores = (value?: number, translate?: ReturnType<typeof useLanguage>["t"]) => {
  if (value === undefined || !Number.isFinite(value) || value < 0)
    return translate?.("research.compute.coreUnknown") ?? "— cores"
  return (
    translate?.("research.compute.coreCount", { count: (value / 100).toFixed(1) }) ??
    `${(value / 100).toFixed(1)} cores`
  )
}

const runs = (kernel: KernelStatus) => `${kernel.execution_count} ${kernel.execution_count === 1 ? "run" : "runs"}`

export const kernelActivity = (
  kernel: KernelStatus,
  now = Date.now(),
  translate?: ReturnType<typeof useLanguage>["t"],
) => {
  if (translate) {
    const state = {
      lazy: "research.compute.lazy",
      starting: "research.compute.starting",
      idle: "research.compute.idle",
      running: "research.compute.running",
      stopped: "research.compute.stopped",
      crashed: "research.compute.crashed",
    } as const
    const count = translate(
      kernel.execution_count === 1 ? "research.compute.runCount.one" : "research.compute.runCount",
      { count: kernel.execution_count },
    )
    const queued =
      kernel.queue_depth > 0 ? ` · ${translate("research.compute.queued", { count: kernel.queue_depth })}` : ""
    if (kernel.state === "running")
      return `${translate(state.running)}${kernel.execution_count > 0 ? ` · ${translate(kernel.execution_count === 1 ? "research.compute.completedRuns.one" : "research.compute.completedRuns", { count: kernel.execution_count })}` : ""}${queued}`
    const idle = kernel.state === "idle" ? age(kernel.last_activity_at, now) : ""
    return `${translate(state[kernel.state])}${idle ? ` ${idle}` : ""} · ${count}${queued}`
  }
  const queued = kernel.queue_depth > 0 ? ` · ${kernel.queue_depth} queued` : ""
  if (kernel.state === "running") {
    const completed = kernel.execution_count > 0 ? ` · ${runs(kernel)} completed` : ""
    return `Running${completed}${queued}`
  }
  if (kernel.state === "starting") return `Starting · ${runs(kernel)}${queued}`
  if (kernel.state === "idle") {
    const idle = age(kernel.last_activity_at, now)
    return `Idle${idle ? ` ${idle}` : ""} · ${runs(kernel)}${queued}`
  }
  return `${kernel.state.charAt(0).toUpperCase()}${kernel.state.slice(1)} · ${runs(kernel)}${queued}`
}

const marker = (kernel: KernelStatus) =>
  kernel.language === "python" ? "kernel.py" : kernel.language === "r" ? "kernel.r" : "kernel.txt"

const environment = (kernel: KernelStatus) => {
  const name = kernel.environment_name?.trim()
  if (!name || name === "default" || name === kernel.language) return
  return name
}

export function KernelCard(props: { kernel: KernelStatus; sample?: number }): JSX.Element {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!props.kernel.active) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const title = () =>
    props.kernel.last_execution?.title?.trim() ||
    props.kernel.last_execution?.source?.trim() ||
    kernelLabel(props.kernel, language.t)

  return (
    <article class="compute-row kernel-card" data-kernel-id={props.kernel.id} data-state={props.kernel.state}>
      <span class="compute-row__kind" aria-label={kernelLanguageLabel(props.kernel)}>
        <FileIcon node={{ path: marker(props.kernel), type: "file" }} />
      </span>
      <div class="compute-row__copy">
        <strong title={title()}>{title()}</strong>
        <span data-slot="kernel-card-executions">
          {kernelActivity(props.kernel, now(), language.t)}
          <Show when={environment(props.kernel)}>{(name) => ` · ${name()}`}</Show>
        </span>
      </div>
      <div class="compute-row__telemetry" aria-label={language.t("research.compute.kernelResources")}>
        <span data-metric="memory">{memory(props.kernel.resources?.memory_bytes)}</span>
        <span data-metric="cpu">{cores(props.kernel.resources?.cpu_percent, language.t)}</span>
      </div>
    </article>
  )
}
