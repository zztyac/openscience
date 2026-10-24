import { describe, expect, test } from "bun:test"
import { dict } from "./en"

const deliberateFragments = new Set([
  // Remote job suffixes follow the main status, e.g. "Succeeded · collecting output".
  "research.compute.collecting",
  "research.compute.recoveryPending",
  "research.compute.cleanupPending",
  "research.compute.remoteUnknown",
  // Existing inline continuations and technical examples, now extracted for translation.
  "atlas.skills.namePlaceholder",
  "interface.model.on",
  "interface.model.off",
  "settings.copy.matched",
  "settings.copy.unmatched",
  "settings.copy.ambiguousBillingRecords",
  "settings.copy.records",
  "settings.copy.credential",
  "settings.copy.concurrentJob",
  "settings.copy.userBastionExampleOrg22Optional",
  "settings.copy.of",
  "settings.copy.selected",
  "settings.copy.tokens",
  "settings.copy.heldForTurnsInFlight",
  "settings.copy.available",
  "settings.copy.whenTheWalletDropsBelow",
  "settings.copy.oskOrThkFromAppSyntheticsciencesAiSettings",
  "settings.copy.domains",
  "settings.copy.unknownCostObservations",
  "settings.copy.stillRunningRestartingNowPausesEachTurnOpenscience",
  "pages.copy.working",
  "pages.copy.unread",
  "pages.copy.draftSaved",
  "pages.copy.recently",
  "pages.copy.artifactSaveFailed",

  "provider.connect.oauth.code.visit.suffix",
  "provider.connect.oauth.auto.visit.suffix",
  // Continuations of a number the panel renders in front of them: "124.9K of 272K tokens".
  "context.headline.of",
  "context.headline.tokens",
  "context.headline.cap",
  "context.usage.ofWindow",
  // Where a provider key comes from, set after its name: "OpenAI · local file", "set in openscience.json".
  "settings.providerKeys.source.api.label",
  "settings.providerKeys.source.env.label",
  "settings.providerKeys.source.env.note",
  "settings.providerKeys.source.config.label",
  "settings.providerKeys.source.config.note",
  "settings.providerKeys.source.custom.label",
  "settings.providerKeys.source.workspace.label",
  "settings.providerKeys.source.workspace.note",
  "settings.providerKeys.source.managed.note",
  "settings.providerKeys.source.external",
])

describe("English interface copy", () => {
  test("uses sentence case instead of accidental lowercase labels", () => {
    const offenders = Object.entries(dict)
      .filter(([key, value]) => {
        const text = String(value).trimStart()
        if (key === "model.provider.xai") return false
        if (deliberateFragments.has(key)) return false
        if (/^https?:\/\//.test(text)) return false
        return /^[a-z]/.test(text)
      })
      .map(([key, value]) => `${key}: ${value}`)

    expect(offenders).toEqual([])
  })

  test("preserves technical acronym casing", () => {
    expect(dict["dialog.mcp.title"]).toBe("MCPs")
    expect(dict["model.input.pdf"]).toBe("PDF")
    expect(dict["provider.connect.method.apiKey"]).toBe("API key")
    expect(dict["status.popover.tab.lsp"]).toBe("LSP")
  })
})
