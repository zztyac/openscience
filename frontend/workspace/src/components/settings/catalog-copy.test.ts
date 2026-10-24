import { expect, test } from "bun:test"
import * as i18n from "@solid-primitives/i18n"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { dict as uiEn } from "@synsci/ui/i18n/en"
import { dict as uiZh } from "@synsci/ui/i18n/zh"
import { networkGroupCopy, credentialServiceCopy, scientificSummaryCopy, scientificCategoryCopy } from "./catalog-copy"
import { updateNotice } from "./startup-update"
import type { Service } from "./credential-loader"

const translate = i18n.translator(() => i18n.flatten({ ...en, ...uiEn, ...zh, ...uiZh }), i18n.resolveTemplate)

test("built-in network descriptions are localized without changing policy identifiers or domains", () => {
  const group = {
    id: "package-management",
    label: "Package management",
    description: "Package indexes",
    domains: ["pypi.org"],
  }
  const localized = networkGroupCopy(group, translate)
  expect(localized.label).toBe("软件包管理")
  expect(localized.description).toContain("软件包索引")
  expect(localized.id).toBe(group.id)
  expect(localized.domains).toBe(group.domains)
  const unknown = { ...group, id: "custom-research", label: "My service" }
  expect(networkGroupCopy(unknown, translate)).toBe(unknown)
})

test("credential metadata translates built-in fields while preserving custom services and protocol values", () => {
  const service: Service = {
    id: "github",
    label: "GitHub",
    description: "Personal access token for repositories and the GitHub API.",
    custom: false,
    connected: false,
    set_fields: [],
    updated_at: null,
    source: null,
    fields: [{ name: "token", label: "Access token", type: "password", optional: false, placeholder: "ghp_…" }],
  }
  const localized = credentialServiceCopy(service, translate)
  expect(localized.label).toBe("GitHub")
  expect(localized.description).toContain("个人访问令牌")
  expect(localized.fields[0]).toEqual({ ...service.fields[0], label: "访问令牌" })
  const custom = { ...service, custom: true, description: "Keep my own description" }
  expect(credentialServiceCopy(custom, translate)).toBe(custom)
  const future = { ...service, id: "future-service" }
  expect(credentialServiceCopy(future, translate)).toBe(future)
})

test("translated updates preserve versions, restart actions and server failure details", () => {
  const ready = updateNotice({ phase: "ready", version: "2.0.127", migration_required: true }, "download", translate)
  expect(ready).toMatchObject({ kind: "ready", primary: { busy: false, label: "迁移并重启" } })
  expect(ready?.title).toContain("2.0.127")
  expect(ready?.detail).toContain("应用程序")
  const error = "Device-specific recovery diagnostic"
  expect(updateNotice({ phase: "failed", error }, "download", translate)).toMatchObject({
    kind: "failed",
    detail: error,
  })
})

test("scientific catalog descriptions translate without changing custom capability text", () => {
  expect(scientificSummaryCopy({ id: "scipy", summary: "Numerical analysis" }, translate)).toContain("数值优化")
  expect(scientificCategoryCopy("bioinformatics", translate)).toBe("生物信息学")
  expect(scientificSummaryCopy({ id: "custom-lab-tool", summary: "Our lab procedure" }, translate)).toBe(
    "Our lab procedure",
  )
})
