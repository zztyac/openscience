import type { JSX } from "solid-js"
import { LanguageProvider, useLanguage, type Locale } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"

const platform: Platform = {
  platform: "web",
  openLink() {},
  async restart() {},
  back() {},
  forward() {},
  async notify() {},
}

export function LanguageFixture(props: {
  children: JSX.Element
  locale?: Locale
  onLanguage?: (language: ReturnType<typeof useLanguage>) => void
}) {
  const Content = () => {
    const language = useLanguage()
    language.setLocale(props.locale ?? "en")
    props.onLanguage?.(language)
    return props.children
  }
  return (
    <PlatformProvider value={platform}>
      <LanguageProvider>
        <Content />
      </LanguageProvider>
    </PlatformProvider>
  )
}
