import { useLanguage } from "@/context/language"
import { Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"

export function StudyFraming(props: {
  study: { id: string; question?: string; hypothesis?: string }
  save: (input: { question: string; hypothesis: string }) => Promise<void>
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ editing: false, busy: false, question: "", hypothesis: "", error: "" })
  createEffect(
    on(
      () => props.study.id,
      () => setState({ editing: false, busy: false, error: "" }),
      { defer: true },
    ),
  )
  const save = async () => {
    if (state.busy) return
    const id = props.study.id
    setState({ busy: true, error: "" })
    await props
      .save({ question: state.question.trim(), hypothesis: state.hypothesis.trim() })
      .then(() => {
        if (props.study.id === id) setState({ editing: false })
      })
      .catch(() => {
        if (props.study.id === id) setState({ error: language.t("atlas.study.saveError") })
      })
      .finally(() => {
        if (props.study.id === id) setState({ busy: false })
      })
  }
  return (
    <section aria-label={language.t("atlas.study.title")}>
      <Show
        when={state.editing}
        fallback={
          <>
            <dl class="ar-facts">
              <div>
                <dt>{language.t("atlas.study.question")}</dt>
                <dd>{props.study.question || language.t("atlas.study.empty")}</dd>
              </div>
              <div>
                <dt>{language.t("atlas.study.hypothesis")}</dt>
                <dd>{props.study.hypothesis || language.t("atlas.study.empty")}</dd>
              </div>
            </dl>
            <Button
              size="small"
              variant="secondary"
              onClick={() =>
                setState({
                  editing: true,
                  question: props.study.question ?? "",
                  hypothesis: props.study.hypothesis ?? "",
                  error: "",
                })
              }
            >
              {language.t("atlas.study.edit")}
            </Button>
          </>
        }
      >
        <form
          class="ar-framing"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label>
            {language.t("atlas.study.question")}
            <textarea
              value={state.question}
              maxLength={4000}
              disabled={state.busy}
              onInput={(event) => setState("question", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("atlas.study.hypothesis")}
            <textarea
              value={state.hypothesis}
              maxLength={4000}
              disabled={state.busy}
              onInput={(event) => setState("hypothesis", event.currentTarget.value)}
            />
          </label>
          <Button type="submit" size="small" disabled={state.busy}>
            {language.t("common.save")}
          </Button>
          <Button
            type="button"
            size="small"
            variant="ghost"
            disabled={state.busy}
            onClick={() => setState({ editing: false, error: "" })}
          >
            {language.t("common.cancel")}
          </Button>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
        </form>
      </Show>
    </section>
  )
}
