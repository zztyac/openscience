import { describe, expect, test } from "bun:test"
import { MeasurementCSVError, measurementTemplate, parseMeasurementCSV } from "./csv"

describe("measurement CSV import", () => {
  test("preserves zero conditions, scientific notation and quoted notes", () => {
    const data = parseMeasurementCSV(
      `\uFEFF${measurementTemplate}S1,control,Jc,1.2e6,A/cm2,77,0,0,PLD,"one, two\nthree"\r\n`,
    )
    expect(data).toEqual([
      {
        sampleID: "S1",
        groupID: "control",
        property: "Jc",
        value: 1200000,
        unit: "A/cm2",
        temperatureK: 77,
        fieldT: 0,
        angleDeg: 0,
        process: "PLD",
        notes: "one, two\nthree",
      },
    ])
  })
  test("leaves unknown conditions absent instead of converting them to zero", () => {
    expect(parseMeasurementCSV(`${measurementTemplate}S1,C,Jc,2,A/cm2,,,,,`)[0].temperatureK).toBeUndefined()
  })
  test("supports required-only columns and escaped quotation marks", () => {
    expect(
      parseMeasurementCSV('sampleID,groupID,property,value,unit,notes\nS1,C,Jc,2,A/cm2,"a ""quote"""')[0].notes,
    ).toBe('a "quote"')
  })
  test.each(["NaN", "Infinity", "0x12", "2 A/cm2", "", "1e999"])("rejects invalid measurement %s", (value) => {
    expect(() => parseMeasurementCSV(`${measurementTemplate}S1,C,Jc,${value},A/cm2,77,1,0,,`)).toThrow(
      MeasurementCSVError,
    )
  })
  test.each(["-1,1,0", "77,-1,0", "77,1,361"])("rejects invalid conditions %s", (conditions) => {
    expect(() => parseMeasurementCSV(`${measurementTemplate}S1,C,Jc,2,A/cm2,${conditions},,`)).toThrow(
      MeasurementCSVError,
    )
  })
  test("rejects empty units, malformed rows, unknown headers and missing data", () => {
    for (const text of [
      `${measurementTemplate}S1,C,Jc,2,,77,1,0,,`,
      `${measurementTemplate}S1,C,Jc`,
      "sampleID,groupID,property,value,unknown\nS1,C,Jc,2,A/cm2",
      measurementTemplate,
      `${measurementTemplate}S1,C,Jc,2,A/cm2,77,1,0,,"broken`,
    ])
      expect(() => parseMeasurementCSV(text)).toThrow(MeasurementCSVError)
  })
})
