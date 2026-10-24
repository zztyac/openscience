import { createSignal } from "solid-js"
import { ThemeProvider } from "@synsci/ui/theme"
import type { Locale } from "@/context/language"
import { SettingsProvider } from "@/context/settings"
import { TestLanguage } from "../../../test/language"
import General from "./General"

export function createGeneralLanguageFixture() {
  const [locale, setLocale] = createSignal<Locale>("en")
  return {
    setLocale,
    view: () => (
      <TestLanguage locale={locale()}>
        <ThemeProvider>
          <SettingsProvider>
            <General />
          </SettingsProvider>
        </ThemeProvider>
      </TestLanguage>
    ),
  }
}
