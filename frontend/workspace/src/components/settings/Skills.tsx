import { useLanguage } from "@/context/language"
import { createUniqueId, type ParentComponent } from "solid-js"
import { createStore } from "solid-js/store"
import SkillsPage from "@/atlas/SkillsPage"
import MaterialsSkills from "./MaterialsSkills"
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

const Skills = () => {
  const language = useLanguage()
  const id = createUniqueId()
  const [state, setState] = createStore({ view: "library" as "library" | "materials" })
  return (
    <SkillsFrame>
      <div
        class="settings-skills__navigation"
        role="tablist"
        aria-label={language.t("settings.copy.skillsSettings")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          const next =
            event.key === "Home"
              ? "library"
              : event.key === "End"
                ? "materials"
                : state.view === "library"
                  ? "materials"
                  : "library"
          setState("view", next)
          event.currentTarget.querySelector<HTMLButtonElement>(`[id="${id}-${next}"]`)?.focus()
        }}
      >
        <button
          type="button"
          id={`${id}-library`}
          role="tab"
          aria-selected={state.view === "library"}
          aria-controls={`${id}-library-content`}
          tabIndex={state.view === "library" ? 0 : -1}
          onClick={() => setState("view", "library")}
        >
          {language.t("settings.copy.materialSkills.library")}
        </button>
        <button
          type="button"
          id={`${id}-materials`}
          role="tab"
          aria-selected={state.view === "materials"}
          aria-controls={`${id}-materials-content`}
          tabIndex={state.view === "materials" ? 0 : -1}
          onClick={() => setState("view", "materials")}
        >
          {language.t("settings.copy.materialSkills.title")}
        </button>
      </div>
      <div
        class="settings-skills__content"
        hidden={state.view !== "library"}
        id={`${id}-library-content`}
        role="tabpanel"
        aria-labelledby={`${id}-library`}
      >
        <SkillsPage embedded />
      </div>
      <div
        class="settings-skills__content"
        hidden={state.view !== "materials"}
        id={`${id}-materials-content`}
        role="tabpanel"
        aria-labelledby={`${id}-materials`}
      >
        <MaterialsSkills />
      </div>
    </SkillsFrame>
  )
}

export default Skills
