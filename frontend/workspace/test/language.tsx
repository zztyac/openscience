import { createEffect, type JSX } from "solid-js"
import { LanguageProvider, useLanguage, type Locale } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"

const platform: Platform = {
  platform: "web",
  openLink() {},
  restart: async () => {},
  back() {},
  forward() {},
  notify: async () => {},
}

interface Props {
  children: JSX.Element
  locale?: Locale
}

function LocaleSelection(props: Props) {
  const language = useLanguage()
  createEffect(() => language.setLocale(props.locale ?? "en"))
  return <>{props.children}</>
}

/** Keep component tests on the same reactive dictionaries as the application. */
export function TestLanguage(props: Props) {
  return (
    <PlatformProvider value={platform}>
      <LanguageProvider>
        <LocaleSelection locale={props.locale}>{props.children}</LocaleSelection>
      </LanguageProvider>
    </PlatformProvider>
  )
}
