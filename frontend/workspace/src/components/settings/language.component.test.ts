import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const server = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [fixture, web] = await Promise.all([
  server.ssrLoadModule("/src/components/settings/language.fixture.tsx") as Promise<typeof import("./language.fixture")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
const ready = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await Bun.sleep(20)
  expect(check()).toBe(true)
}

test("General updates its heading, theme, sounds and release notes when the selected language changes", async () => {
  const subject = fixture.createGeneralLanguageFixture()
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(subject.view, host))
  const notes = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "View notes")
  expect(host.querySelector("h2")?.textContent).toBe("General")
  expect(host.querySelector('[aria-label="Theme"]')).not.toBeNull()
  expect(notes()).toBeDefined()
  const languageControl = host.querySelector('[aria-label="Language"]')

  subject.setLocale("zh")
  await ready(() => host.querySelector("h2")?.textContent === "常规")
  expect(host.textContent).toContain("设置 OpenScience 在此设备上的外观和行为。")
  expect(host.querySelector('[aria-label="主题"]')).not.toBeNull()
  expect(host.textContent).toContain("查看更新说明")
  expect(host.textContent).not.toContain("View notes")
  expect(host.textContent).not.toContain("Sound effects")
  expect(host.querySelector('[aria-label="语言"]')).toBe(languageControl)

  subject.setLocale("en")
  await ready(() => host.querySelector("h2")?.textContent === "General")
  expect(host.querySelector('[aria-label="Theme"]')).not.toBeNull()
  expect(notes()).toBeDefined()
})
