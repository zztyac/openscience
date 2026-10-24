/**
 * How long ago something happened, coarsened to one unit. A group header wants
 * the bare span ("3h") and a card wants it as a phrase ("3h ago"), which is the
 * only difference between the two and not a reason to write it twice.
 */
const span = (created: number) => {
  const minutes = Math.max(1, Math.round((Date.now() - created) / 60_000))
  if (minutes < 60) return { value: minutes, unit: "minute" as const, suffix: "m" }
  const hours = Math.round(minutes / 60)
  return hours < 24
    ? { value: hours, unit: "hour" as const, suffix: "h" }
    : { value: Math.round(hours / 24), unit: "day" as const, suffix: "d" }
}

const localeTag = (locale: string) => (locale === "zht" ? "zh-TW" : locale === "br" ? "pt-BR" : locale)

export const age = (created: number, locale = "en") => {
  const time = span(created)
  if (locale === "en") return `${time.value}${time.suffix}`
  return new Intl.NumberFormat(localeTag(locale), {
    style: "unit",
    unit: time.unit,
    unitDisplay: "narrow",
  }).format(time.value)
}

export const ago = (created: number, locale = "en") => {
  if (locale === "en") return `${age(created)} ago`
  const time = span(created)
  return new Intl.RelativeTimeFormat(localeTag(locale), { style: "short" }).format(-time.value, time.unit)
}
