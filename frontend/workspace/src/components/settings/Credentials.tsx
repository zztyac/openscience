import { useLanguage } from "@/context/language"
import { type Component } from "solid-js"
import { CredentialServices } from "./CredentialServices"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"

const Credentials: Component = () => {
  const language = useLanguage()
  return (
    <PanelScroll>
      <PanelHeader
        title={language.t("settings.shell.panel.credentials")}
        description={language.t("settings.copy.addServiceCredentialsOnceAndMakeThemAvailable")}
      />
      <PanelBody>
        <CredentialServices
          category="integration"
          title={language.t("settings.copy.integrations")}
          description={language.t("settings.copy.nvidiaGithubOpenalexHuggingFaceAndOtherResearch")}
          custom
        />
      </PanelBody>
    </PanelScroll>
  )
}

export default Credentials
