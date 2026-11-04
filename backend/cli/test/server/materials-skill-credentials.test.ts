import { expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { CredentialsRoutes } from "../../src/server/routes/settings/credentials"

test("retrieval credentials use the encrypted store and live canonical environment without exposing values", async () => {
  const api = CredentialsRoutes()
  const previous = { EXA_API_KEY: process.env.EXA_API_KEY, DEEPXIV_API_KEY: process.env.DEEPXIV_API_KEY }
  delete process.env.EXA_API_KEY
  delete process.env.DEEPXIV_API_KEY
  try {
    for (const [service, variable] of [
      ["exa", "EXA_API_KEY"],
      ["deepxiv", "DEEPXIV_API_KEY"],
    ] as const) {
      const value = `test-only-${service}-retrieval-key`
      const response = await api.request(`/${service}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { api_key: value } }),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toContain(value)
      const services = JSON.parse(text).services as Array<{
        id: string
        connected: boolean
        set_fields: string[]
        category: string
        custom: boolean
      }>
      expect(services.find((item) => item.id === service)).toMatchObject({
        connected: true,
        set_fields: ["api_key"],
        category: "integration",
        custom: false,
      })
      expect(process.env[variable]).toBe(value)
      expect(await Bun.file(path.join(Global.Path.data, "credentials.json")).text()).not.toContain(value)
      const deleted = await api.request(`/${service}`, { method: "DELETE" })
      expect(deleted.status).toBe(200)
      expect(process.env[variable]).toBeUndefined()
    }
  } finally {
    for (const service of ["exa", "deepxiv"]) await api.request(`/${service}`, { method: "DELETE" })
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
