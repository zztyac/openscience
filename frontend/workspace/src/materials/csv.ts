import { MaterialMeasurement } from "@synsci/util/materials"

export const measurementColumns = [
  "sampleID",
  "groupID",
  "property",
  "value",
  "unit",
  "temperatureK",
  "fieldT",
  "angleDeg",
  "process",
  "notes",
] as const
export const measurementTemplate = `${measurementColumns.join(",")}\n`
export class MeasurementCSVError extends Error {
  constructor(
    readonly code: "empty" | "quotes" | "headers" | "columns" | "number" | "invalid" | "limit",
    readonly row = 1,
    readonly field = "",
  ) {
    super(`${code}: row ${row}${field ? `, ${field}` : ""}`)
  }
}

function rows(text: string): string[][] {
  const result: string[][] = []
  let cells: string[] = []
  let cell = ""
  let quoted = false
  let ended = false
  const input = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char !== '"') {
        cell += char
        continue
      }
      if (input[i + 1] === '"') {
        cell += '"'
        i++
        continue
      }
      quoted = false
      ended = true
      continue
    }
    if (char === '"') {
      if (cell || ended) throw new MeasurementCSVError("quotes", result.length + 1)
      quoted = true
      continue
    }
    if (char === ",") {
      cells.push(cell)
      cell = ""
      ended = false
      continue
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && input[i + 1] === "\n") i++
      cells.push(cell)
      if (cells.some((value) => value.trim())) result.push(cells)
      cells = []
      cell = ""
      ended = false
      continue
    }
    if (ended) throw new MeasurementCSVError("quotes", result.length + 1)
    cell += char
  }
  if (quoted) throw new MeasurementCSVError("quotes", result.length + 1)
  cells.push(cell)
  if (cells.some((value) => value.trim())) result.push(cells)
  return result
}

export function parseMeasurementCSV(text: string): MaterialMeasurement[] {
  if (text.length > 2_000_000) throw new MeasurementCSVError("limit")
  const parsed = rows(text)
  if (parsed.length < 2) throw new MeasurementCSVError("empty")
  if (parsed.length > 5001) throw new MeasurementCSVError("limit")
  const header = parsed[0].map((item) => item.trim())
  const required = ["sampleID", "groupID", "property", "value", "unit"]
  if (
    new Set(header).size !== header.length ||
    required.some((key) => !header.includes(key)) ||
    header.some((key) => !measurementColumns.includes(key as (typeof measurementColumns)[number]))
  )
    throw new MeasurementCSVError("headers")
  return parsed.slice(1).map((row, index) => {
    const line = index + 2
    if (row.length !== header.length) throw new MeasurementCSVError("columns", line)
    const record: Record<string, string | number | undefined> = Object.fromEntries(
      header.map((key, i) => [key, row[i].trim()]),
    )
    for (const field of ["value", "temperatureK", "fieldT", "angleDeg"]) {
      const value = record[field]
      if ((value === "" || value === undefined) && field !== "value") {
        delete record[field]
        continue
      }
      if (
        typeof value !== "string" ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ||
        !Number.isFinite(Number(value))
      )
        throw new MeasurementCSVError("number", line, field)
      record[field] = Number(value)
    }
    const result = MaterialMeasurement.safeParse(record)
    if (!result.success) throw new MeasurementCSVError("invalid", line, result.error.issues[0]?.path.join(".") ?? "")
    return result.data
  })
}

export function csvError(error: unknown, locale: string): string {
  if (!(error instanceof MeasurementCSVError)) return error instanceof Error ? error.message : String(error)
  const labels = {
    empty: [
      "CSV 至少需要表头和一条测量数据。",
      "CSV 至少需要標頭和一筆量測資料。",
      "CSV requires a header and at least one measurement.",
    ],
    quotes: ["引号格式不正确。", "引號格式不正確。", "Malformed quoted field."],
    headers: [
      "表头缺失、重复或包含未知列，请使用模板中的列名。",
      "標頭缺失、重複或包含未知欄，請使用範本中的欄名。",
      "Missing, duplicate or unknown columns. Use the template column names.",
    ],
    columns: ["数据列数与表头不一致。", "資料欄數與標頭不一致。", "Column count does not match the header."],
    number: [
      "需要有效数字，请勿将单位写在数值中。",
      "需要有效數字，請勿將單位寫在數值中。",
      "Enter a valid number without a unit suffix.",
    ],
    invalid: [
      "缺少必填值，或数据超出范围。温度与磁场须非负，角度须在 −360 至 360 度内。",
      "缺少必填值，或資料超出範圍。溫度與磁場須非負，角度須在 −360 至 360 度內。",
      "Missing required value or out of range. Temperature and field must be nonnegative; angle must be between −360 and 360 degrees.",
    ],
    limit: [
      "CSV 不能超过 2 MB 或 5000 条测量记录。",
      "CSV 不能超過 2 MB 或 5000 筆量測記錄。",
      "CSV must be under 2 MB and 5,000 measurements.",
    ],
  }
  const index = locale === "zh" ? 0 : locale === "zht" ? 1 : 2
  return `${index === 2 ? "Row" : "第"} ${error.row}${index === 2 ? "" : " 行"}${error.field ? ` · ${error.field}` : ""}：${labels[error.code][index]}`
}
