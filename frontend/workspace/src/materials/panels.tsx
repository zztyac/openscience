import { createEffect, createMemo, For, on, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import {
  MaterialAnalysis,
  MaterialIdeas,
  MaterialIntake,
  MaterialProtocol,
  MaterialStrategies,
  type MaterialArtifact,
  type MaterialDecision,
  type MaterialProject,
  type MaterialSourceInput,
  type MaterialBatchInput,
  type MaterialStage,
} from "@synsci/util/materials"
import { csvError, MeasurementCSVError, measurementTemplate, parseMeasurementCSV } from "./csv"
import { download, sourceText } from "./files"
import type { Translator } from "./i18n"
import { readStatistics } from "./statistics"

export type PanelProps = {
  project: MaterialProject
  t: Translator
  locale: string
  busy: boolean
  action: (value: Omit<(typeof MaterialDecision)["_output"], "revision">) => Promise<boolean>
  saveSource: (value: (typeof MaterialSourceInput)["_output"], file?: File) => Promise<boolean>
  saveBatch: (value: Omit<(typeof MaterialBatchInput)["_output"], "revision">) => Promise<boolean>
}

export function Empty(props: { text: string }) {
  return (
    <div class="mat-empty">
      <span aria-hidden="true">◇</span>
      <p>{props.text}</p>
    </div>
  )
}
function List(props: { title: string; values: string[] }) {
  return (
    <Show when={props.values.length}>
      <section class="mat-detail">
        <h3>{props.title}</h3>
        <ul>
          <For each={props.values}>{(value) => <li>{value}</li>}</For>
        </ul>
      </section>
    </Show>
  )
}
function Detail(props: { title: string; children: JSX.Element }) {
  return (
    <section class="mat-detail">
      <h3>{props.title}</h3>
      <div>{props.children}</div>
    </section>
  )
}
function latest(project: MaterialProject, stage: MaterialStage) {
  return project.artifacts.filter((item) => item.stage === stage).at(-1)
}
function sourceURL(value?: string) {
  const url = value && URL.canParse(value) ? new URL(value) : undefined
  return url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
}

export function ArtifactView(props: {
  project: MaterialProject
  stage: MaterialStage
  t: Translator
  locale: string
  children: (artifact: MaterialArtifact) => JSX.Element
}) {
  const [state, setState] = createStore({ id: "" })
  const artifacts = createMemo(() => props.project.artifacts.filter((item) => item.stage === props.stage))
  const selected = createMemo(() => artifacts().find((item) => item.id === state.id) ?? artifacts().at(-1))
  return (
    <Show when={selected()} fallback={<Empty text={props.t("stageEmpty")} />}>
      {(artifact) => (
        <>
          <div class="mat-artifact-heading">
            <div>
              <h2>{artifact().title}</h2>
              <p>{new Date(artifact().createdAt).toLocaleString(props.locale === "zht" ? "zh-TW" : props.locale)}</p>
            </div>
            <label class="mat-version">
              {props.t("version")}
              <select
                aria-label={props.t("version")}
                value={artifact().id}
                onChange={(event) => setState("id", event.currentTarget.value)}
              >
                <For each={artifacts()}>{(item) => <option value={item.id}>{item.version}</option>}</For>
              </select>
            </label>
          </div>
          {props.children(artifact())}
        </>
      )}
    </Show>
  )
}

export function Evidence(props: {
  project: MaterialProject
  t: Translator
  evidence: { sourceID: string; quote: string; page?: number; chunkID?: string }
}) {
  const source = () => props.project.sources.find((item) => item.id === props.evidence.sourceID)
  const chunk = () => source()?.chunks?.find((item) => item.id === props.evidence.chunkID)
  const page = () => props.evidence.page ?? chunk()?.page
  const position = () => source()?.chunks?.findIndex((item) => item.id === props.evidence.chunkID) ?? -1
  const url = () => sourceURL(source()?.retrieval?.url) ?? sourceURL(source()?.url)
  return (
    <details class="mat-evidence">
      <summary>
        {props.t("evidence")}{" "}
        <span>
          {source()?.title ?? props.t("sourceMissing")}
          {page() ? ` · ${props.t("page")} ${page()}` : ""}
          {position() >= 0 ? ` · ${props.t("evidenceChunk")} ${position() + 1}` : ""}
        </span>
      </summary>
      <blockquote>{props.evidence.quote}</blockquote>
      <Show when={chunk()}>
        {(value) => (
          <details class="mat-evidence-context">
            <summary>{props.t("evidenceContext")}</summary>
            <p class="mat-prose">{value().text}</p>
          </details>
        )}
      </Show>
      <Show when={url()}>
        {(url) => (
          <a href={url()} target="_blank" rel="noopener noreferrer">
            {props.t("viewSource")} ↗
          </a>
        )}
      </Show>
    </details>
  )
}

export function Overview(props: PanelProps) {
  const [form, setForm] = createStore({ answers: "" })
  const intake = createMemo(() => {
    const result = MaterialIntake.safeParse(latest(props.project, "intake")?.data)
    return result.success ? result.data : undefined
  })
  return (
    <div class="mat-panel-grid">
      <div>
        <section class="mat-card">
          <h2>{props.t("goal")}</h2>
          <p class="mat-prose">{props.project.goal}</p>
          <Show when={intake()}>
            {(value) => (
              <>
                <p class="mat-domain-label">{value().materialSystem}</p>
                <List title={props.t("conditions")} values={value().constraints} />
              </>
            )}
          </Show>
        </section>
        <Show when={props.project.status === "needs_input"}>
          <section class="mat-card mat-attention">
            <h2>{props.t("answer")}</h2>
            <ol>
              <For each={props.project.questions}>{(question) => <li>{question}</li>}</For>
            </ol>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (form.answers.trim())
                  void props.action({ action: "answer", answers: form.answers }).then((ok) => {
                    if (ok) setForm("answers", "")
                  })
              }}
            >
              <label class="mat-field">
                <span>{props.t("answer")}</span>
                <textarea
                  required
                  value={form.answers}
                  onInput={(event) => setForm("answers", event.currentTarget.value)}
                  placeholder={props.t("answerPlaceholder")}
                  rows={5}
                  maxLength={20000}
                />
              </label>
              <button class="mat-button mat-button--primary" disabled={props.busy || !form.answers.trim()}>
                {props.t("continue")}
              </button>
            </form>
          </section>
        </Show>
        <section class="mat-card">
          <h2>{props.t("artifacts")}</h2>
          <div class="mat-metrics">
            <div>
              <strong>{props.project.sources.length}</strong>
              <span>{props.t("sources")}</span>
            </div>
            <div>
              <strong>{props.project.artifacts.length}</strong>
              <span>{props.t("artifacts")}</span>
            </div>
            <div>
              <strong>{props.project.batches.length}</strong>
              <span>{props.t("batches")}</span>
            </div>
          </div>
          <p class="mat-muted">{props.t("evidenceHint")}</p>
        </section>
      </div>
      <section class="mat-card mat-timeline">
        <h2>{props.t("timeline")}</h2>
        <Show when={props.project.events.length} fallback={<p class="mat-muted">{props.t("noEvents")}</p>}>
          <ol>
            <For each={[...props.project.events].reverse()}>
              {(event) => (
                <li data-kind={event.kind}>
                  <time>
                    {new Date(event.createdAt).toLocaleTimeString(props.locale === "zht" ? "zh-TW" : props.locale)}
                  </time>
                  <p>{event.message}</p>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
    </div>
  )
}

export function Sources(props: PanelProps) {
  const locked = () =>
    !!props.project.approvedProtocolID || props.project.artifacts.some((item) => item.stage === "strategies")
  const running = () => ["running", "queued"].includes(props.project.status)
  const canRefresh = () =>
    !locked() &&
    !running() &&
    !props.project.questions.length &&
    props.project.stages.some((stage) => stage.key === "intake" && stage.status === "completed")
  const [form, setForm] = createStore({
    title: "",
    authors: "",
    doi: "",
    url: "",
    kind: "fulltext" as "fulltext" | "abstract" | "note",
    text: "",
    loading: false,
    error: "",
    notice: "",
    file: undefined as File | undefined,
  })
  let uploadEpoch = 0
  let mounted = true
  onCleanup(() => {
    mounted = false
    uploadEpoch++
  })
  createEffect(
    on(
      () => props.project.id,
      () => {
        uploadEpoch++
        setForm({
          title: "",
          authors: "",
          doi: "",
          url: "",
          text: "",
          file: undefined,
          loading: false,
          error: "",
          notice: "",
        })
      },
    ),
  )
  async function upload(file?: File) {
    if (!file) return
    const epoch = ++uploadEpoch
    setForm({
      loading: true,
      error: "",
      notice: "",
      file: undefined,
      text: "",
      title: file.name.replace(/\.[^.]+$/, ""),
    })
    try {
      const text = await sourceText(file, props.t)
      if (mounted && epoch === uploadEpoch) setForm({ text, file })
    } catch (error) {
      if (mounted && epoch === uploadEpoch) setForm("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted && epoch === uploadEpoch) setForm("loading", false)
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (locked() || running() || form.loading || props.busy) return
    if (!form.title.trim() || form.text.trim().length < 20) {
      setForm("error", props.t("sourceValidation"))
      return
    }
    setForm({ error: "", notice: "", loading: true })
    const epoch = uploadEpoch
    const ok = await props
      .saveSource(
        {
          title: form.title.trim(),
          authors: form.authors.trim(),
          kind: form.kind,
          text: form.text,
          doi: form.doi.trim() || undefined,
          url: form.url.trim() || undefined,
        },
        form.file,
      )
      .catch((error: unknown) => {
        if (mounted && epoch === uploadEpoch) setForm("error", error instanceof Error ? error.message : String(error))
        return false
      })
    if (!mounted || epoch !== uploadEpoch) return
    if (ok)
      setForm({ title: "", authors: "", doi: "", url: "", text: "", file: undefined, notice: props.t("sourceSaved") })
    setForm("loading", false)
  }
  return (
    <div class="mat-panel-grid">
      <div>
        <section class="mat-card">
          <h2>{props.t("literature")}</h2>
          <Show when={canRefresh()}>
            <p class="mat-muted">{props.t("refreshLiteratureHint")}</p>
            <button
              class="mat-button"
              disabled={props.busy || form.loading}
              onClick={() => void props.action({ action: "refresh_literature" })}
            >
              {props.t("refreshLiterature")}
            </button>
          </Show>
          <Show when={latest(props.project, "literature")}>
            {(artifact) => <p class="mat-prose mat-artifact-text">{artifact().markdown}</p>}
          </Show>
          <Show when={props.project.sources.length} fallback={<Empty text={props.t("noSources")} />}>
            <div class="mat-source-list">
              <For each={props.project.sources}>
                {(source) => (
                  <details class="mat-source">
                    <summary>
                      <span class="mat-type">{props.t(source.kind)}</span>
                      <strong>{source.title}</strong>
                      <small>{[source.authors, source.year, source.doi].filter(Boolean).join(" · ")}</small>
                      <Show when={source.retrieval?.pageCount || source.chunks?.length}>
                        <small>
                          {[
                            source.retrieval?.pageCount ? `${props.t("pageCount")}: ${source.retrieval.pageCount}` : "",
                            source.chunks?.length ? `${props.t("evidenceChunks")}: ${source.chunks.length}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </Show>
                    </summary>
                    <Show when={source.kind === "abstract" && source.retrieval?.status === "unavailable"}>
                      <p class="mat-muted">{props.t("fulltextUnavailable")}</p>
                    </Show>
                    <Show when={source.retrieval?.reason}>{(reason) => <p class="mat-muted">{reason()}</p>}</Show>
                    <Show when={sourceURL(source.retrieval?.url) ?? sourceURL(source.url)}>
                      {(url) => (
                        <a href={url()} target="_blank" rel="noopener noreferrer">
                          {props.t("viewSource")} ↗
                        </a>
                      )}
                    </Show>
                    <Show when={source.text.length > 6000}>
                      <p class="mat-muted">{props.t("sourceExcerpt")}</p>
                    </Show>
                    <pre>{source.text.slice(0, 6000)}</pre>
                  </details>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
      <section class="mat-card">
        <h2>{props.t("upload")}</h2>
        <p class="mat-muted">{props.t("uploadHint")}</p>
        <Show when={locked() || running()}>
          <p class="mat-inline-note mat-attention">{props.t(locked() ? "sourcesLocked" : "sourcesRunning")}</p>
        </Show>
        <form onSubmit={(event) => void submit(event)}>
          <label class="mat-upload">
            {form.loading ? props.t("extracting") : props.t("chooseFile")}
            <input
              type="file"
              accept=".pdf,.txt,.md,.markdown"
              disabled={form.loading || props.busy}
              onChange={(event) => {
                void upload(event.currentTarget.files?.[0])
                event.currentTarget.value = ""
              }}
            />
          </label>
          <Show when={form.file}>
            {(file) => (
              <div class="mat-original-file">
                <span>
                  {props.t("originalFile")} · {file().name}
                </span>
                <button
                  type="button"
                  class="mat-button"
                  disabled={form.loading || props.busy}
                  onClick={() => setForm("file", undefined)}
                >
                  {props.t("removeOriginal")}
                </button>
                <p class="mat-muted">{props.t("originalFileHint")}</p>
              </div>
            )}
          </Show>
          <label class="mat-field">
            <span>{props.t("title")}</span>
            <input
              required
              maxLength={500}
              value={form.title}
              onInput={(event) => setForm("title", event.currentTarget.value)}
            />
          </label>
          <label class="mat-field">
            <span>{props.t("authors")}</span>
            <input
              maxLength={2000}
              value={form.authors}
              onInput={(event) => setForm("authors", event.currentTarget.value)}
            />
          </label>
          <div class="mat-form-row">
            <label class="mat-field">
              <span>DOI</span>
              <input maxLength={300} value={form.doi} onInput={(event) => setForm("doi", event.currentTarget.value)} />
            </label>
            <label class="mat-field">
              <span>URL</span>
              <input type="url" value={form.url} onInput={(event) => setForm("url", event.currentTarget.value)} />
            </label>
          </div>
          <label class="mat-field">
            <span>{props.t("kind")}</span>
            <select
              value={form.kind}
              onChange={(event) => setForm("kind", event.currentTarget.value as typeof form.kind)}
            >
              <For each={["fulltext", "abstract", "note"] as const}>
                {(kind) => <option value={kind}>{props.t(kind)}</option>}
              </For>
            </select>
          </label>
          <label class="mat-field">
            <span>{props.t("sourceText")}</span>
            <textarea
              required
              minLength={20}
              maxLength={200000}
              rows={9}
              value={form.text}
              onInput={(event) => setForm("text", event.currentTarget.value)}
            />
          </label>
          <Show when={form.error}>
            <p role="alert" class="mat-error">
              {form.error}
            </p>
          </Show>
          <Show when={form.notice}>
            <p role="status" class="mat-success">
              {form.notice}
            </p>
          </Show>
          <button class="mat-button mat-button--primary" disabled={form.loading || props.busy || locked() || running()}>
            {form.loading ? props.t("saving") : props.t("saveSource")}
          </button>
        </form>
      </section>
    </div>
  )
}

export function Strategies(props: PanelProps) {
  return (
    <ArtifactView project={props.project} stage="strategies" t={props.t} locale={props.locale}>
      {(artifact) => {
        const parsed = MaterialStrategies.safeParse(artifact.data)
        if (!parsed.success) return <p class="mat-prose">{artifact.markdown}</p>
        const data = parsed.data
        return (
          <>
            <div class="mat-strategies">
              <For each={data.nodes}>
                {(node, index) => (
                  <article class="mat-card mat-strategy">
                    <div class="mat-node-number">{String(index() + 1).padStart(2, "0")}</div>
                    <h3>{node.title}</h3>
                    <For each={node.records}>
                      {(record) => (
                        <section class="mat-strategy-record">
                          <span class="mat-type">{record.dimension}</span>
                          <h4>{record.strategy}</h4>
                          <p>{record.effect}</p>
                          <Evidence {...props} evidence={record.evidence} />
                        </section>
                      )}
                    </For>
                    <Show when={node.limitations.length}>
                      <h4>{props.t("limitations")}</h4>
                      <For each={node.limitations}>
                        {(item) => (
                          <div class="mat-limitation">
                            <p>{item.limitation}</p>
                            <p class="mat-muted">{item.expectation}</p>
                            <Evidence {...props} evidence={item.evidence} />
                          </div>
                        )}
                      </For>
                    </Show>
                  </article>
                )}
              </For>
            </div>
            <Show when={data.edges.length}>
              <section class="mat-card">
                <h3>{props.t("connections")}</h3>
                <For each={data.edges}>
                  {(edge) => (
                    <div class="mat-connection">
                      <span>{data.nodes.find((item) => item.id === edge.parentID)?.title ?? edge.parentID}</span>
                      <span aria-hidden="true">→</span>
                      <span>{data.nodes.find((item) => item.id === edge.childID)?.title ?? edge.childID}</span>
                      <span class="mat-type">{props.t(edge.type)}</span>
                      <p>{edge.rationale}</p>
                    </div>
                  )}
                </For>
              </section>
            </Show>
            <section class="mat-card">
              <List title={props.t("gaps")} values={data.coverageGaps} />
              <List title={props.t("reviews")} values={data.reviewNotes} />
            </section>
          </>
        )
      }}
    </ArtifactView>
  )
}

export function Ideas(props: PanelProps) {
  const [form, setForm] = createStore({ selected: [...props.project.selectedIdeaIDs] })
  return (
    <ArtifactView project={props.project} stage="ideas" t={props.t} locale={props.locale}>
      {(artifact) => {
        const parsed = MaterialIdeas.safeParse(artifact.data)
        if (!parsed.success) return <p class="mat-prose">{artifact.markdown}</p>
        const data = parsed.data
        const canSelect = () =>
          (props.project.status === "awaiting_approval" ||
            (props.project.status === "completed" && props.project.target === "ideas")) &&
          artifact.id === latest(props.project, "ideas")?.id &&
          !latest(props.project, "protocol")
        return (
          <>
            <section class="mat-card">
              <h3>{props.t("comparison")}</h3>
              <p>{data.comparison}</p>
              <p class="mat-muted">{props.t("selectionHint")}</p>
            </section>
            <div class="mat-ideas">
              <For each={data.ideas.toSorted((a, b) => a.rank - b.rank)}>
                {(idea) => (
                  <article class="mat-card mat-idea">
                    <div class="mat-idea-top">
                      <span class="mat-node-number">{String(idea.rank).padStart(2, "0")}</span>
                      <span
                        class="mat-badge"
                        data-status={idea.review.decision === "accept" ? "completed" : "awaiting_approval"}
                      >
                        {props.t(idea.review.decision)}
                      </span>
                    </div>
                    <h3>{idea.title}</h3>
                    <span class="mat-type">{props.t(idea.status)}</span>
                    <Detail title={props.t("hypothesis")}>{idea.hypothesis}</Detail>
                    <Detail title={props.t("design")}>{idea.design}</Detail>
                    <Detail title={props.t("mechanism")}>{idea.mechanism}</Detail>
                    <div class="mat-two-column">
                      <Detail title={props.t("novelty")}>{idea.novelty}</Detail>
                      <Detail title={props.t("feasibility")}>{idea.feasibility}</Detail>
                    </div>
                    <List title={props.t("risks")} values={idea.risks} />
                    <Detail title={props.t("validation")}>{idea.validation}</Detail>
                    <Detail title={props.t("reviews")}>
                      <p>{idea.review.rationale}</p>
                      <ul>
                        <For each={idea.review.issues}>{(issue) => <li>{issue}</li>}</For>
                      </ul>
                    </Detail>
                    <For each={idea.evidence}>{(evidence) => <Evidence {...props} evidence={evidence} />}</For>
                    <Show when={canSelect()}>
                      <label class="mat-check">
                        <input
                          type="checkbox"
                          disabled={idea.review.decision !== "accept" || props.busy}
                          checked={form.selected.includes(idea.id)}
                          onChange={(event) =>
                            setForm(
                              "selected",
                              event.currentTarget.checked
                                ? [...form.selected, idea.id]
                                : form.selected.filter((id) => id !== idea.id),
                            )
                          }
                        />
                        <span>{props.t("selectIdea")}</span>
                      </label>
                    </Show>
                  </article>
                )}
              </For>
            </div>
            <Show when={canSelect()}>
              <div class="mat-action-bar">
                <button
                  class="mat-button mat-button--primary"
                  disabled={
                    props.busy ||
                    !data.ideas.some((idea) => idea.review.decision === "accept" && form.selected.includes(idea.id))
                  }
                  onClick={() =>
                    void props.action({
                      action: "select_ideas",
                      ideaIDs: data.ideas
                        .filter((idea) => idea.review.decision === "accept" && form.selected.includes(idea.id))
                        .map((idea) => idea.id),
                    })
                  }
                >
                  {props.t("generateProtocol")}
                </button>
              </div>
            </Show>
          </>
        )
      }}
    </ArtifactView>
  )
}

export function Protocol(props: PanelProps) {
  const [form, setForm] = createStore({ confirmedID: "", revision: "" })
  return (
    <ArtifactView project={props.project} stage="protocol" t={props.t} locale={props.locale}>
      {(artifact) => {
        const parsed = MaterialProtocol.safeParse(artifact.data)
        if (!parsed.success) return <p class="mat-prose">{artifact.markdown}</p>
        const data = parsed.data
        return (
          <>
            <section class="mat-card">
              <p class="mat-prose">{data.objective}</p>
              <h3>{props.t("groups")}</h3>
              <div class="mat-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{props.t("group")}</th>
                      <th>{props.t("purpose")}</th>
                      <th>{props.t("variables")}</th>
                      <th>{props.t("replicates")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={data.groups}>
                      {(group) => (
                        <tr>
                          <td>
                            <strong>{group.name}</strong>
                            <code>{group.id}</code>
                          </td>
                          <td>{group.purpose}</td>
                          <td>{group.variables}</td>
                          <td>{group.replicates}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </section>
            <div class="mat-panel-grid">
              <section class="mat-card">
                <h3>{props.t("steps")}</h3>
                <ol class="mat-protocol-steps">
                  <For each={data.steps.toSorted((a, b) => a.order - b.order)}>
                    {(step) => (
                      <li>
                        <span>{step.order}</span>
                        <div>
                          <p>{step.instruction}</p>
                          <p class="mat-muted">{step.rationale}</p>
                        </div>
                      </li>
                    )}
                  </For>
                </ol>
              </section>
              <section class="mat-card">
                <h3>{props.t("parameters")}</h3>
                <For each={data.parameters}>
                  {(parameter) => (
                    <div class="mat-parameter">
                      <h4>
                        {parameter.name}
                        <span class="mat-type">
                          {props.t(parameter.basis === "literature" ? "literatureBasis" : parameter.basis)}
                        </span>
                      </h4>
                      <p>
                        {parameter.value} {parameter.unit}
                      </p>
                      <For each={parameter.evidence}>{(evidence) => <Evidence {...props} evidence={evidence} />}</For>
                    </div>
                  )}
                </For>
              </section>
            </div>
            <section class="mat-card mat-two-column">
              <div>
                <List title={props.t("measurements")} values={data.measurements} />
                <List title={props.t("criteria")} values={data.successCriteria} />
              </div>
              <div>
                <List title={props.t("risks")} values={data.risks} />
                <List title={props.t("confirmations")} values={data.confirmations} />
              </div>
            </section>
            <Show
              when={props.project.approvedProtocolID === artifact.id}
              fallback={
                <Show
                  when={
                    props.project.status === "awaiting_approval" &&
                    artifact.id === latest(props.project, "protocol")?.id
                  }
                >
                  <section class="mat-card mat-attention">
                    <p>{props.t("approveHint")}</p>
                    <label class="mat-check">
                      <input
                        type="checkbox"
                        checked={form.confirmedID === artifact.id}
                        onChange={(event) => setForm("confirmedID", event.currentTarget.checked ? artifact.id : "")}
                      />
                      <span>{props.t("confirmRead")}</span>
                    </label>
                    <button
                      class="mat-button mat-button--primary"
                      disabled={props.busy || form.confirmedID !== artifact.id}
                      onClick={() => void props.action({ action: "approve_protocol", protocolID: artifact.id })}
                    >
                      {props.t("approveProtocol")}
                    </button>
                    <details class="mat-revise">
                      <summary>{props.t("reviseProtocol")}</summary>
                      <p class="mat-muted">{props.t("reviseProtocolHint")}</p>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          if (!form.revision.trim() || props.busy) return
                          void props.action({ action: "revise_protocol", answers: form.revision.trim() }).then((ok) => {
                            if (ok) setForm({ revision: "", confirmedID: "" })
                          })
                        }}
                      >
                        <label class="mat-field">
                          <span>{props.t("reviseProtocol")}</span>
                          <textarea
                            rows={4}
                            maxLength={20000}
                            required
                            value={form.revision}
                            onInput={(event) => setForm("revision", event.currentTarget.value)}
                          />
                        </label>
                        <button class="mat-button" disabled={props.busy || !form.revision.trim()}>
                          {props.t("reviseProtocolSubmit")}
                        </button>
                      </form>
                    </details>
                  </section>
                </Show>
              }
            >
              <p class="mat-success">✓ {props.t("approved")}</p>
            </Show>
          </>
        )
      }}
    </ArtifactView>
  )
}

export function Analysis(props: PanelProps) {
  const [form, setForm] = createStore({ name: "", csv: measurementTemplate, error: "", notice: "", loading: false })
  const editable = () => ["awaiting_data", "completed"].includes(props.project.status)
  const protocol = createMemo(() =>
    MaterialProtocol.safeParse(
      props.project.artifacts.find((item) => item.id === props.project.approvedProtocolID)?.data,
    ),
  )
  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (form.loading || props.busy || !editable()) return
    setForm({ error: "", notice: "" })
    if (!form.name.trim() || !props.project.approvedProtocolID) {
      setForm("error", props.t("csvRequired"))
      return
    }
    try {
      const measurements = parseMeasurementCSV(form.csv)
      const parsed = protocol()
      if (
        !parsed.success ||
        measurements.some((item) => !parsed.data.groups.some((group) => group.id === item.groupID))
      ) {
        setForm("error", props.t("groupInvalid"))
        return
      }
      setForm("loading", true)
      const ok = await props.saveBatch({
        name: form.name.trim(),
        protocolID: props.project.approvedProtocolID,
        measurements,
        rawCSV: form.csv,
      })
      if (ok) setForm({ name: "", csv: measurementTemplate, notice: props.t("batchSaved") })
    } catch (error) {
      setForm("error", csvError(error, props.locale))
    } finally {
      setForm("loading", false)
    }
  }
  function condition(value: number | null | undefined, suffix: string) {
    return value === undefined || value === null ? props.t("unspecified") : `${value} ${suffix}`
  }
  return (
    <>
      <div class="mat-panel-grid">
        <section class="mat-card">
          <h2>{props.t("analysis")}</h2>
          <p class="mat-muted">{props.t("dataHint")}</p>
          <Show
            when={props.project.approvedProtocolID}
            fallback={<p class="mat-attention mat-inline-note">{props.t("approvalRequired")}</p>}
          >
            <form onSubmit={(event) => void submit(event)}>
              <label class="mat-field">
                <span>{props.t("batchName")}</span>
                <input
                  required
                  maxLength={200}
                  value={form.name}
                  onInput={(event) => setForm("name", event.currentTarget.value)}
                />
              </label>
              <Show when={protocol().success}>
                {(_success) => {
                  const parsed = protocol()
                  return parsed.success ? (
                    <p class="mat-muted">
                      {props.t("groups")}:{" "}
                      {parsed.data.groups.map((group) => `${group.id} (${group.name})`).join(" · ")}
                    </p>
                  ) : null
                }}
              </Show>
              <div class="mat-form-row">
                <button
                  type="button"
                  class="mat-button"
                  onClick={() => download("measurements-template.csv", measurementTemplate, "text/csv;charset=utf-8")}
                >
                  {props.t("template")}
                </button>
                <label class="mat-upload mat-upload--compact">
                  {props.t("csvUpload")}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    disabled={form.loading || props.busy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ""
                      if (!file) return
                      if (file.size > 2_000_000) {
                        setForm("error", csvError(new MeasurementCSVError("limit"), props.locale))
                        return
                      }
                      void file
                        .text()
                        .then((csv) => setForm("csv", csv))
                        .catch((error) => setForm("error", csvError(error, props.locale)))
                    }}
                  />
                </label>
              </div>
              <label class="mat-field">
                <span>{props.t("csv")}</span>
                <textarea
                  class="mat-csv"
                  spellcheck={false}
                  rows={7}
                  value={form.csv}
                  onInput={(event) => setForm("csv", event.currentTarget.value)}
                />
              </label>
              <Show when={form.error}>
                <p role="alert" class="mat-error">
                  {form.error}
                </p>
              </Show>
              <Show when={form.notice}>
                <p role="status" class="mat-success">
                  {form.notice}
                </p>
              </Show>
              <button class="mat-button mat-button--primary" disabled={props.busy || form.loading || !editable()}>
                {form.loading ? props.t("saving") : props.t("saveBatch")}
              </button>
            </form>
          </Show>
        </section>
        <section class="mat-card">
          <h2>{props.t("batches")}</h2>
          <Show when={props.project.batches.length} fallback={<Empty text={props.t("noBatches")} />}>
            <For each={props.project.batches}>
              {(batch) => (
                <div class="mat-batch">
                  <strong>{batch.name}</strong>
                  <span>
                    {batch.measurements.length} · {props.t("measurements")}
                  </span>
                  <time>
                    {new Date(batch.createdAt).toLocaleString(props.locale === "zht" ? "zh-TW" : props.locale)}
                  </time>
                </div>
              )}
            </For>
            <button
              class="mat-button mat-button--primary"
              disabled={props.busy || !editable()}
              onClick={() => void props.action({ action: "analyze" })}
            >
              {props.t("analyze")}
            </button>
          </Show>
        </section>
      </div>
      <For each={props.project.batches}>
        {(batch) => (
          <section class="mat-card">
            <h3>{batch.name}</h3>
            <div class="mat-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{props.t("sample")}</th>
                    <th>{props.t("group")}</th>
                    <th>{props.t("property")}</th>
                    <th>{props.t("value")}</th>
                    <th>{props.t("unit")}</th>
                    <th>{props.t("conditions")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={batch.measurements}>
                    {(item) => (
                      <tr>
                        <td>{item.sampleID}</td>
                        <td>{item.groupID}</td>
                        <td>{item.property}</td>
                        <td>{item.value}</td>
                        <td>{item.unit}</td>
                        <td>
                          {condition(item.temperatureK, "K")} / {condition(item.fieldT, "T")} /{" "}
                          {condition(item.angleDeg, "°")}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </section>
        )}
      </For>
      <Show when={latest(props.project, "analysis")}>
        <ArtifactView project={props.project} stage="analysis" t={props.t} locale={props.locale}>
          {(artifact) => {
            const parsed = MaterialAnalysis.safeParse(artifact.data)
            if (!parsed.success) return <p class="mat-prose">{artifact.markdown}</p>
            const data = parsed.data
            return (
              <section class="mat-card">
                <p class="mat-prose">{data.summary}</p>
                <Detail title={props.t("hypothesisAssessment")}>{data.hypothesisAssessment}</Detail>
                <List title={props.t("findings")} values={data.findings} />
                <List title={props.t("limitations")} values={data.limitations} />
                <List title={props.t("nextSteps")} values={data.nextSteps} />
                <Show when={readStatistics(artifact.data.statistics)}>
                  {(statistics) => (
                    <>
                      <h3>{props.t("statistics")}</h3>
                      <div class="mat-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>{props.t("group")}</th>
                              <th>{props.t("property")}</th>
                              <th>{props.t("conditions")}</th>
                              <th>
                                {props.t("count")} / {props.t("sampleCount")}
                              </th>
                              <th>{props.t("mean")}</th>
                              <th>{props.t("deviation")}</th>
                              <th>{props.t("range")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={statistics().groups}>
                              {(group) => (
                                <tr>
                                  <td>{group.groupID}</td>
                                  <td>
                                    {group.property}
                                    <br />
                                    {group.unit}
                                  </td>
                                  <td>
                                    {condition(group.temperatureK, "K")} / {condition(group.fieldT, "T")} /{" "}
                                    {condition(group.angleDeg, "°")}
                                  </td>
                                  <td>
                                    {group.recordCount} / {group.sampleCount}
                                  </td>
                                  <td>{group.mean.toLocaleString(undefined, { maximumSignificantDigits: 6 })}</td>
                                  <td>
                                    {group.sampleStandardDeviation === null
                                      ? "—"
                                      : group.sampleStandardDeviation.toLocaleString(undefined, {
                                          maximumSignificantDigits: 6,
                                        })}
                                  </td>
                                  <td>
                                    {group.min} – {group.max}
                                  </td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                      <List title={props.t("limitations")} values={statistics().warnings} />
                    </>
                  )}
                </Show>
              </section>
            )
          }}
        </ArtifactView>
      </Show>
    </>
  )
}
