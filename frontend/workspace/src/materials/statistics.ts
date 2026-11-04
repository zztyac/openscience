export type StatisticGroup = {
  protocolID: string
  property: string
  unit: string
  groupID: string
  temperatureK: number | null
  fieldT: number | null
  angleDeg: number | null
  recordCount: number
  sampleCount: number
  mean: number
  sampleStandardDeviation: number | null
  min: number
  max: number
}
function group(value: unknown): value is StatisticGroup {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    ["protocolID", "property", "unit", "groupID"].every((key) => typeof record[key] === "string") &&
    ["recordCount", "sampleCount", "mean", "min", "max"].every(
      (key) => typeof record[key] === "number" && Number.isFinite(record[key]),
    ) &&
    ["temperatureK", "fieldT", "angleDeg", "sampleStandardDeviation"].every(
      (key) => record[key] === null || (typeof record[key] === "number" && Number.isFinite(record[key])),
    )
  )
}
export function readStatistics(value: unknown): { groups: StatisticGroup[]; warnings: string[] } | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (
    !Array.isArray(record.groups) ||
    !record.groups.every(group) ||
    !Array.isArray(record.warnings) ||
    !record.warnings.every((item) => typeof item === "string")
  )
    return
  return { groups: record.groups, warnings: record.warnings }
}
