import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as uiEn } from "@synsci/ui/i18n/en"
import { dict as uiZh } from "@synsci/ui/i18n/zh"
import { dict as uiZht } from "@synsci/ui/i18n/zht"

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()

for (const [name, base, translated] of [
  ["workspace zh", en, zh],
  ["workspace zht", en, zht],
  ["shared UI zh", uiEn, uiZh],
  ["shared UI zht", uiEn, uiZht],
] as const) {
  describe(name, () => {
    test("has a translation for every English fallback entry", () => {
      const entries: Record<string, string> = translated
      expect(Object.keys(base).filter((key) => !(key in entries))).toEqual([])
    })

    test("preserves the values interpolated into each message", () => {
      const entries: Record<string, string> = translated
      for (const [key, value] of Object.entries(base)) {
        if (!entries[key]) continue
        expect(placeholders(entries[key]), key).toEqual(placeholders(value))
      }
    })
  })
}
