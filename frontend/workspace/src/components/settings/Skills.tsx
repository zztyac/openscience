import { useLanguage } from "@/context/language"
import { type ParentComponent } from "solid-js"
import SkillsPage from "@/atlas/SkillsPage"
import "./skills.css"

export { skillIconFor } from "@/atlas/SkillsPage"

export const SkillsFrame: ParentComponent = (props) => {
  const language = useLanguage()
  return (
    <section class="settings-skills" aria-label={language.t("settings.copy.skillsSettings")}>
      {props.children}
    </section>
  )
}

const Skills = () => (
  <SkillsFrame>
    <SkillsPage embedded />
  </SkillsFrame>
)

export default Skills
