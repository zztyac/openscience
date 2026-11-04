import { MaterialBatch, type MaterialMeasurement, type MaterialProject } from "@synsci/util/materials"

export type MeasurementRecord = MaterialMeasurement & { batchID: string; protocolID: string }
export type MaterialStatistics = ReturnType<typeof computeStatistics>

/** Descriptive summaries only: repeated measurements are not independent samples. */
export function computeStatistics(batches: MaterialProject["batches"]) {
  const records = batches.flatMap((batch) => {
    const parsed = MaterialBatch.parse(batch)
    return parsed.measurements.map((item) => ({ ...item, batchID: parsed.id, protocolID: parsed.protocolID }))
  })
  const grouped = new Map<string, MeasurementRecord[]>()
  for (const item of records) {
    const key = JSON.stringify([
      item.protocolID,
      item.property,
      item.unit,
      item.temperatureK ?? null,
      item.fieldT ?? null,
      item.angleDeg ?? null,
      item.groupID,
    ])
    const found = grouped.get(key)
    if (found) found.push(item)
    else grouped.set(key, [item])
  }
  const groups = [...grouped.values()].map((items) => {
    const first = items[0]
    const missingConditions = (["temperatureK", "fieldT", "angleDeg"] as const).filter(
      (key) => first[key] === undefined,
    )
    const mean = items.reduce((sum, item) => sum + item.value / items.length, 0)
    const variance =
      items.length < 2 ? null : items.reduce((sum, item) => sum + (item.value - mean) ** 2 / (items.length - 1), 0)
    const deviation = variance === null ? null : Math.sqrt(variance)
    return {
      protocolID: first.protocolID,
      property: first.property,
      unit: first.unit,
      temperatureK: first.temperatureK ?? null,
      fieldT: first.fieldT ?? null,
      angleDeg: first.angleDeg ?? null,
      groupID: first.groupID,
      conditionStatus: missingConditions.length ? ("incomplete" as const) : ("complete" as const),
      missingConditions,
      recordCount: items.length,
      sampleCount: new Set(items.map((item) => item.sampleID)).size,
      mean,
      sampleStandardDeviation: deviation !== null && Number.isFinite(deviation) ? deviation : null,
      min: items.reduce((min, item) => Math.min(min, item.value), Infinity),
      max: items.reduce((max, item) => Math.max(max, item.value), -Infinity),
      records: items,
    }
  })
  const units = new Map<string, Set<string>>()
  for (const item of records) {
    const found = units.get(item.property) ?? new Set<string>()
    found.add(item.unit)
    units.set(item.property, found)
  }
  const warnings = [
    "均值与样本标准差按测量记录计算；同一样品的重复测量不代表独立样品，不能把记录数当作实验重复数。",
    "仅比较性质、原始单位、温度、磁场、角度与组别一致的数据；不同实验方案分别统计，未自动换算单位。",
    ...(groups.some((item) => item.conditionStatus === "incomplete")
      ? ["部分数据缺少温度、磁场或角度，已单独分组；缺失条件不能理解为零或与已知条件相同。"]
      : []),
    ...[...units]
      .filter(([, values]) => values.size > 1)
      .map(([property, values]) => `性质 ${property} 存在不可直接合并的单位：${[...values].join("、")}。`),
    ...(groups.some((item) => item.recordCount === 1) ? ["仅一条记录的组无法估计样本标准差，结果为 null。"] : []),
    ...(groups.some((item) => item.recordCount > 1 && item.sampleStandardDeviation === null)
      ? ["部分数值超出标准差计算范围，标准差标为 null，请核查原始数值及单位。"]
      : []),
  ]
  return { groups, records, warnings }
}
