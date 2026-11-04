import { afterAll, afterEach, expect, test } from "bun:test"
import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { MaterialSkillSnapshot, type MaterialSkillConfig, materialStages } from "@synsci/util/materials"
import { createTestServer } from "../../../test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule(
  "/src/components/settings/MaterialsSkills.tsx",
)) as typeof import("./MaterialsSkills")
const language = (await vite.ssrLoadModule("/test/language.tsx")) as typeof import("../../../test/language")
const cleanups: Array<() => void> = []
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
  expect(check()).toBe(true)
}
function snapshot() {
  return MaterialSkillSnapshot.parse({
    revision: 3,
    stages: {
      intake: [],
      literature: ["arxiv", "openalex", "semantic-scholar", "research-lit"],
      strategies: [],
      ideas: [],
      protocol: [],
      analysis: [],
    },
    catalog: ["arxiv", "deepxiv", "exa-search", "openalex", "research-lit", "semantic-scholar"].map((name) => ({
      name,
      description: name,
      available: name !== "exa-search",
      ...(name === "exa-search" ? { reason: "Configure an Exa API key in Credentials." } : {}),
    })),
  })
}
async function mount(options: { locale?: "en" | "zh" | "zht"; data?: MaterialSkillSnapshot; invalid?: boolean } = {}) {
  const state = {
    data: options.data ?? snapshot(),
    invalid: options.invalid ?? false,
    fail: 0,
    delay: 0,
    requests: [] as Array<{ method: string; path: string; body?: MaterialSkillConfig }>,
  }
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
    response.setHeader("access-control-allow-headers", "content-type")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as MaterialSkillConfig) : undefined
    state.requests.push({ method: request.method!, path: request.url!, body })
    if (state.delay) await Bun.sleep(state.delay)
    response.setHeader("content-type", "application/json")
    if (state.fail) {
      response.writeHead(state.fail)
      response.end(JSON.stringify({ error: state.fail === 409 ? "Configuration changed" : "Temporarily unavailable" }))
      return
    }
    if (body) state.data = { ...state.data, stages: body.stages, revision: state.data.revision + 1 }
    response.end(JSON.stringify(state.invalid ? { revision: "bad", stages: {} } : state.data))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected loopback listener")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      web.createComponent(language.TestLanguage, {
        locale: options.locale ?? "en",
        get children() {
          return subject.default({
            services: { sdk: { url: `http://127.0.0.1:${address.port}` }, platform: { fetch } },
          })
        },
      }),
    host,
  )
  cleanups.push(() => {
    dispose()
    server.closeAllConnections()
    server.close()
  })
  await ready(() => host.querySelector(".materials-skills")?.getAttribute("aria-busy") === "false")
  const checkbox = (stage: string, skill: string) =>
    host.querySelector<HTMLInputElement>(`input[name="${stage}:${skill}"]`)!
  const save = () => host.querySelector<HTMLButtonElement>('.materials-skills__actions button[data-variant="primary"]')!
  const reload = () => host.querySelector<HTMLButtonElement>('.materials-skills__actions button[data-variant="ghost"]')!
  return { host, state, checkbox, save, reload }
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("edits independent stage bindings and saves only the configuration with its revision", async () => {
  const { host, state, checkbox, save } = await mount()
  expect(host.querySelectorAll("details")).toHaveLength(6)
  expect(save().disabled).toBe(true)
  expect(checkbox("literature", "arxiv").checked).toBe(true)
  expect(checkbox("ideas", "arxiv").checked).toBe(false)
  checkbox("ideas", "arxiv").click()
  expect(save().disabled).toBe(false)
  expect(checkbox("literature", "arxiv").checked).toBe(true)
  save().click()
  await ready(() => host.textContent?.includes("Saved. Applies when a stage next starts.") ?? false)
  const writes = state.requests.filter((request) => request.method === "POST")
  expect(writes).toHaveLength(1)
  expect(writes[0].body?.revision).toBe(3)
  expect(writes[0].body?.stages.ideas).toEqual(["arxiv"])
  expect(writes[0].body?.stages.literature).toEqual(snapshot().stages.literature)
  expect(Object.keys(writes[0].body!)).toEqual(["revision", "stages"])
  expect(state.requests.every((request) => request.path === "/materials/skills")).toBe(true)
  expect(save().disabled).toBe(true)
})

test("unavailable sources explain prerequisites and can still be removed from saved stages", async () => {
  const data = snapshot()
  data.stages.protocol = ["exa-search"]
  const { host, checkbox, save } = await mount({ data })
  expect(host.textContent).toContain("Configure an Exa API key in Credentials.")
  expect(checkbox("literature", "exa-search").disabled).toBe(true)
  expect(checkbox("protocol", "exa-search").disabled).toBe(false)
  checkbox("protocol", "exa-search").click()
  expect(checkbox("protocol", "exa-search").checked).toBe(false)
  expect(save().disabled).toBe(false)
})

test("conflicting saves retain edits until an explicit reload of the latest revision", async () => {
  const { host, state, checkbox, save, reload } = await mount()
  checkbox("strategies", "deepxiv").click()
  state.fail = 409
  save().click()
  await ready(() => !!host.querySelector('[role="alert"]'))
  expect(host.textContent).toContain("This configuration changed elsewhere")
  expect(checkbox("strategies", "deepxiv").checked).toBe(true)
  expect(save().disabled).toBe(true)
  state.fail = 0
  state.data.revision = 8
  state.data.stages.analysis = ["openalex"]
  reload().click()
  await ready(() => checkbox("analysis", "openalex").checked)
  expect(checkbox("strategies", "deepxiv").checked).toBe(false)
  checkbox("intake", "arxiv").click()
  save().click()
  await ready(() => state.requests.filter((request) => request.method === "POST").length === 2)
  expect(state.requests.filter((request) => request.method === "POST")[1].body?.revision).toBe(8)
})

test("invalid responses do not produce editable settings and can be refreshed", async () => {
  const { host, state, reload, save } = await mount({ invalid: true })
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect(host.textContent).toContain("The server returned an invalid stage configuration")
  expect(save().disabled).toBe(true)
  state.invalid = false
  reload().click()
  await ready(() => host.querySelectorAll('input[type="checkbox"]').length === 36)
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

test("pending saves disable edits and duplicate submissions; failures preserve choices for retry", async () => {
  const { host, state, checkbox, save } = await mount()
  checkbox("protocol", "arxiv").click()
  state.delay = 50
  state.fail = 503
  save().click()
  save().click()
  expect(save().disabled).toBe(true)
  expect(host.querySelector("fieldset")?.disabled).toBe(true)
  await ready(() => !!host.querySelector('[role="alert"]'))
  expect(state.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(checkbox("protocol", "arxiv").checked).toBe(true)
  expect(save().disabled).toBe(false)
  state.fail = 0
  save().click()
  await ready(() => host.textContent?.includes("Saved. Applies when a stage next starts.") ?? false)
  expect(state.requests.filter((request) => request.method === "POST")).toHaveLength(2)
})

test("returning to the same selected skill set clears the dirty state", async () => {
  const { checkbox, save } = await mount()
  checkbox("literature", "arxiv").click()
  expect(save().disabled).toBe(false)
  checkbox("literature", "arxiv").click()
  expect(save().disabled).toBe(true)
})

test.each(["zh", "zht", "en"] as const)("stage labels and actions are localized in %s", async (locale) => {
  const { host } = await mount({ locale })
  const title = locale === "zh" ? "材料科研阶段" : locale === "zht" ? "材料科研階段" : "Materials research stages"
  await ready(() => host.textContent?.includes(title) ?? false)
  expect(host.textContent).not.toContain("settings.copy.")
  expect(host.querySelectorAll("fieldset")).toHaveLength(materialStages.length)
  expect(host.textContent).toContain(title)
})
