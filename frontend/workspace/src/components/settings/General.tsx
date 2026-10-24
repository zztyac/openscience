import { useLanguage } from "@/context/language"
import { AppearanceSections } from "../settings-general"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"
import "./preference-panels.css"

/**
 * App preferences: appearance, notifications, sounds. Account and billing
 * live under Ace; trace sharing sits with the other consent controls under
 * Permissions.
 */
export default function General() {
  const language = useLanguage()
  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--general">
        <PanelHeader
          title={language.t("settings.shell.panel.general")}
          description={language.t("settings.copy.howOpenscienceLooksAndBehavesOnThisDevice")}
        />
        <PanelBody>
          <AppearanceSections />
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
