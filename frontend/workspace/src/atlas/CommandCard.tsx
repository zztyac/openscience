import { useLanguage } from "@/context/language"
import { createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { kernelMemoryLabel, type CommandStatus } from "@/atlas/kernel-runtime"

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

const elapsed = (started: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - started) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function CommandCard(props: { command: CommandStatus; sample?: number }): JSX.Element {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  return (
    <article class="compute-row command-card" data-command-id={props.command.id} data-state="running">
      <span class="compute-row__kind" aria-label={language.t("research.compute.shell")}>
        <Icon name="console" />
      </span>
      <div class="compute-row__copy">
        <strong title={props.command.description}>{props.command.description}</strong>
        <span>
          {language.t("research.compute.running")} · {elapsed(props.command.started_at, now())}
        </span>
      </div>
      <div class="compute-row__telemetry" aria-label={language.t("research.compute.commandResources")}>
        <span data-metric="memory">{memory(props.command.resources?.memory_bytes)}</span>
        <span data-metric="cpu">{cores(props.command.resources?.cpu_percent, language.t)}</span>
      </div>
    </article>
  )
}
