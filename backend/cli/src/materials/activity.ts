import { MaterialActivityUpdate, type MaterialReporter, type MaterialStage } from "@synsci/util/materials"
import type { MaterialsStore } from "./store"

/** Persist milestones immediately; coalesce stream chunks without retaining model output. */
export function materialActivity(store: MaterialsStore, id: string, stage: MaterialStage, signal: AbortSignal) {
  const token = store.beginActivity(id, stage)
  let closed = !token
  let latest: MaterialActivityUpdate | undefined
  let pending: { update: MaterialActivityUpdate; time: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let written = 0

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (closed || !pending || !token) return
    store.reportActivity(id, token, pending.update, pending.time)
    written = Date.now()
    pending = undefined
  }
  const dispose = () => {
    closed = true
    clearTimeout(timer)
    pending = undefined
    signal.removeEventListener("abort", dispose)
  }
  const report: MaterialReporter = (input) => {
    if (closed || signal.aborted || !token) return
    const update = MaterialActivityUpdate.parse(input)
    const streamed =
      ["reasoning", "generating"].includes(update.phase) &&
      latest &&
      ["phase", "role", "model", "step", "steps", "item"].every(
        (key) => latest?.[key as keyof MaterialActivityUpdate] === update[key as keyof MaterialActivityUpdate],
      )
    if (!streamed) flush()
    latest = update
    pending = { update, time: Date.now() }
    if (!streamed || Date.now() - written >= 1_000) flush()
    else timer ??= setTimeout(flush, 1_000 - (Date.now() - written))
    timer?.unref()
  }
  signal.addEventListener("abort", dispose, { once: true })
  if (signal.aborted) dispose()
  return {
    report,
    flush,
    finish(phase: "completed" | "failed") {
      if (closed || !token) return
      flush()
      store.finishActivity(id, token, phase)
      dispose()
    },
    dispose,
  }
}
