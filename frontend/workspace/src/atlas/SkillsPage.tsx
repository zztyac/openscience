import { useLanguage } from "@/context/language"
// Skills — the catalog of playbooks agents load on demand, in the tiers the
// agent itself uses: the Core toolkit first, the user's own skills, then the
// library by subject with each shelf folded until it is wanted. Data,
// selection, authoring and sources all go through the real APIs.
import {
  For,
  Show,
  Switch as Branch,
  Match,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { Switch } from "@synsci/ui/switch"
import { createStore } from "solid-js/store"
import { AtomLoader } from "@synsci/ui/atom-loader"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useGlobalSync } from "@/context/global-sync"
import type { Config } from "@synsci/sdk/v2/client"
import { installFromGit } from "./skills-settings"
import {
  setSkillPinned,
  skillCatalogSnapshot,
  skillAction,
  skillPreferences,
  SKILL_PREFERENCES_EVENT,
} from "./skill-permissions"
import "./skills-page.css"
import { SearchInput, AddMenu, EmptyState, FormField, FormButton } from "@/components/settings/_shared"
import { skillIconFor } from "./skill-icon"
import {
  compareCore,
  coreSkill,
  selectedSkills,
  skillCatalogKey,
  skillSelection,
  skillSource,
  type SkillSource,
  type SkillView,
} from "./skill-selection"

export { skillIconFor } from "./skill-icon"

export interface Skill {
  name: string
  description?: string
  summary?: string
  location: string
  origin?: SkillSource
  category?: string
  tags?: string[]
  entry?: boolean
  permission_action?: "allow" | "ask" | "deny"
  recommended?: boolean
  enabled?: boolean
  disabled_by?: "server" | "project"
  catalog_status?: string
}

export interface SkillRoot {
  path: string
  kind: "bundled" | "project" | "user" | "installed" | "config" | "runtime"
  skills: number
  shadowed: number
}

export interface SkillRoots {
  roots: SkillRoot[]
  shadowed: Array<{ name: string; location: string; by: string }>
}

const memorySkillCache = new Map<string, Skill[]>()
const skillCatalogRequests = new Map<string, Promise<Skill[]>>()
const FLAT_ROWS = 120

function cachedSkills(key: string) {
  if (memorySkillCache.has(key)) return memorySkillCache.get(key)!
  try {
    if (typeof sessionStorage === "undefined") return []
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "null") as { skills?: Skill[] } | null
    if (!Array.isArray(parsed?.skills)) return []
    memorySkillCache.set(key, parsed.skills)
    return parsed.skills
  } catch {
    return []
  }
}

function rememberSkills(key: string, skills: Skill[]) {
  memorySkillCache.set(key, skills)
  try {
    if (typeof sessionStorage === "undefined") return
    sessionStorage.setItem(key, JSON.stringify({ skills }))
  } catch {
    // The in-memory cache still makes later Settings visits immediate.
  }
}

function loadSkillCatalog(key: string, load: () => Promise<Skill[]>) {
  const pending = skillCatalogRequests.get(key)
  if (pending) return pending
  const request = load()
    .then((skills) => {
      if (skillCatalogRequests.get(key) === request) rememberSkills(key, skills)
      return skills
    })
    .finally(() => {
      if (skillCatalogRequests.get(key) === request) skillCatalogRequests.delete(key)
    })
  skillCatalogRequests.set(key, request)
  return request
}

type Form =
  { kind: "list" } | { kind: "scratch" } | { kind: "github" } | { kind: "folder" } | { kind: "edit"; name: string }

export function displayLabel(value: string) {
  const words = value.replace(/[-_]+/g, " ").trim()
  if (/^(ml|llm|ai)\b/i.test(words)) return words.replace(/^(ml|llm|ai)\b/i, (m) => m.toUpperCase())
  return words ? words[0]!.toUpperCase() + words.slice(1) : value
}

/** One line under a title: the summary when the author wrote one, otherwise
 * the first sentence of the description. */
export function blurb(skill: Pick<Skill, "summary" | "description">) {
  const text = (skill.summary || skill.description || "").trim()
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? ""
  return first.replace(/[.!]$/, "")
}

export type SkillsPageServices = {
  server: string
  load: () => Promise<Skill[]>
  disabled: () => readonly string[]
  permission: () => unknown
  select: (names: string[], enabled: boolean) => Promise<readonly string[]>
  create: (name: string, content: string) => Promise<unknown>
  read: (name: string) => Promise<string>
  remove: (name: string) => Promise<unknown>
  install: (url: string) => Promise<{ installed: unknown[]; rejected: unknown[] }>
  roots: () => Promise<SkillRoots>
  addRoot: (path: string, persist?: "global" | "project") => Promise<SkillRoot>
  removeRoot: (path: string, persist?: "global" | "project") => Promise<unknown>
  watch?: (refresh: () => void) => () => void
}

export default function SkillsPage(props: { embedded?: boolean; services?: SkillsPageServices }): JSX.Element {
  const language = useLanguage()
  const rootLabels = (): Record<SkillRoot["kind"], string> => ({
    bundled: language.t("atlas.skills.source.bundled"),
    project: language.t("atlas.skills.source.project"),
    user: language.t("atlas.skills.personal"),
    installed: language.t("atlas.skills.source.installed"),
    config: language.t("atlas.skills.source.configured"),
    runtime: language.t("atlas.skills.source.registered"),
  })

  const service =
    props.services ??
    (() => {
      const sdk = useGlobalSDK()
      const platform = usePlatform()
      const sync = useGlobalSync()
      type SelectionConfig = Config & { skills?: { paths?: string[]; disabled?: string[] } }
      return {
        server: sdk.url,
        load: async () => (await sdk.client.app.skills()).data ?? [],
        disabled: () => (sync.data.config as SelectionConfig).skills?.disabled ?? [],
        permission: () => sync.data.config.permission,
        select: async (names: string[], enabled: boolean) => {
          // Re-read before a queued edit so selections made elsewhere survive.
          const current = (await sdk.client.global.config.get()).data as SelectionConfig
          const disabled = skillSelection(current.skills?.disabled ?? [], names, enabled)
          const saved = (await sync.updateConfig({ skills: { disabled } } as SelectionConfig)).data as
            SelectionConfig | undefined
          if (
            !saved?.skills?.disabled ||
            JSON.stringify([...saved.skills.disabled].sort()) !== JSON.stringify([...disabled].sort())
          ) {
            throw new Error(language.t("atlas.skills.serverSelectionError"))
          }
          sync.set("config", "skills", { ...sync.data.config.skills, disabled } as SelectionConfig["skills"])
          return disabled
        },
        create: (name: string, content: string) => sdk.client.app.skill.write({ name, content }),
        read: async (name: string) => {
          const result = await sdk.client.app.skill.content({ name })
          if (!result.data) throw new Error(language.t("atlas.skills.readError"))
          return result.data.content
        },
        remove: (name: string) => sdk.client.app.skill.delete({ name }),
        install: (url: string) => installFromGit(platform.fetch ?? fetch, sdk.url, url),
        roots: async () => {
          const result = await sdk.client.settings.skills.roots()
          if (!result.data) throw new Error(language.t("atlas.skills.sourcesError"))
          return result.data
        },
        addRoot: async (path: string, persist?: "global" | "project") => {
          const result = await sdk.client.settings.skills.addRoot({ path, persist })
          if (!result.data) {
            const error = result.error as { error?: string } | undefined
            throw new Error(error?.error ?? language.t("atlas.skills.folderError"))
          }
          return result.data
        },
        removeRoot: (path: string, persist?: "global" | "project") =>
          sdk.client.settings.skills.removeRoot({ path, persist }),
        watch: (refresh: () => void) =>
          sdk.event.listen((event) => {
            if (event.details?.type === "skill.updated") refresh()
          }),
      } satisfies SkillsPageServices
    })()

  const cacheKey = skillCatalogKey(service.server)
  const initialSkills = cachedSkills(cacheKey)
  const [skills, skillsCtl] = createResource(() => loadSkillCatalog(cacheKey, service.load), {
    initialValue: initialSkills,
  })
  const [roots, rootsCtl] = createResource(() => service.roots().catch(() => undefined))
  const refresh = () => {
    skillCatalogRequests.delete(cacheKey)
    void skillsCtl.refetch()
    void rootsCtl.refetch()
  }
  if (service.watch) onCleanup(service.watch(refresh))

  const [search, setSearch] = createSignal("")
  const [form, setForm] = createSignal<Form>({ kind: "list" })
  const [busy, setBusy] = createSignal(false)
  const [flatRows, setFlatRows] = createSignal(FLAT_ROWS)
  const [openShelves, setOpenShelves] = createSignal<ReadonlySet<string>>(new Set())
  const storage = (() => {
    try {
      return globalThis.localStorage
    } catch {
      return undefined
    }
  })()
  const [preferences, setPreferences] = createStore({
    view: "all" as SkillView,
    feedback: "",
    changes: {} as Record<string, { enabled: boolean; version: number }>,
  })
  const initialPreferences = skillPreferences(storage)
  const [pinned, setPinned] = createSignal(initialPreferences.pinned)
  const [permissionPending, setPermissionPending] = createSignal<Record<string, number>>({})
  const permissionVersions = new Map<string, number>()
  let permissionWrites = Promise.resolve()
  let fileInput: HTMLInputElement | undefined

  // Selection never changes permission or re-enables a security-blocked skill.
  const catalog = createMemo(() =>
    skillCatalogSnapshot(
      (skills() ?? initialSkills).map((skill) => ({
        ...skill,
        enabled:
          skill.disabled_by === "project"
            ? false
            : (preferences.changes[skill.name]?.enabled ?? skill.enabled ?? !service.disabled().includes(skill.name)),
        permission_action: skill.permission_action ?? skillAction(service.permission(), skill.name),
      })),
      { pinned: pinned() },
    ),
  )
  const activeNames = createMemo(() => new Set(catalog().allowed.map((skill) => skill.name)))
  const enabled = (name: string) => activeNames().has(name)
  // When most active skills ask first, that is the permission mode, said
  // once in the summary; rows only mark the exceptions.
  const asksEverywhere = createMemo(() => {
    const allowed = catalog().allowed
    if (!allowed.length) return false
    const asking = allowed.filter((skill) => catalog().action(skill.name) === "ask").length
    return asking * 2 > allowed.length
  })

  function markPermissionPending(name: string, delta: number) {
    setPermissionPending((current) => {
      const next = { ...current }
      const count = (next[name] ?? 0) + delta
      if (count > 0) next[name] = count
      else delete next[name]
      return next
    })
  }

  function toggle(names: string[], next: boolean) {
    if (!names.length) return
    const versions = names.map((name) => {
      const version = (permissionVersions.get(name) ?? 0) + 1
      permissionVersions.set(name, version)
      setPreferences("changes", name, { enabled: next, version })
      markPermissionPending(name, 1)
      return [name, version] as const
    })
    setPreferences("feedback", language.t("atlas.skills.saveSelection"))

    const persist = async () => {
      try {
        await service.select(names, next)
        const changed = new Set(names)
        skillsCtl.mutate((current) =>
          (current ?? []).map((skill) =>
            changed.has(skill.name) && skill.disabled_by !== "project"
              ? { ...skill, enabled: next, disabled_by: next ? undefined : "server" }
              : skill,
          ),
        )
        setPreferences(
          "feedback",
          next
            ? language.t("atlas.skills.activatedCount", { count: names.length })
            : language.t("atlas.skills.deactivatedCount", { count: names.length }),
        )
      } catch (error) {
        setPreferences("feedback", language.t("atlas.skills.selectionError"))
        showToast({
          variant: "error",
          title: language.t("atlas.skills.selectionErrorTitle"),
          description: message(error),
        })
      } finally {
        for (const [name, version] of versions) {
          if (permissionVersions.get(name) === version) setPreferences("changes", name, undefined!)
          markPermissionPending(name, -1)
        }
      }
    }
    permissionWrites = permissionWrites.then(persist, persist)
  }

  const all = createMemo(() => catalog().library)
  const enabledCount = createMemo(() => catalog().allowed.length)
  const pinnedNames = createMemo(() => new Set(pinned()))
  const query = createMemo(() => search().trim().toLowerCase())

  const matches = (skill: Skill) => {
    const q = query()
    if (!q) return true
    return [skill.name, skill.description ?? "", skill.summary ?? "", skill.category ?? "", ...(skill.tags ?? [])].some(
      (value) => value.toLowerCase().includes(q),
    )
  }
  const filtered = createMemo(() =>
    selectedSkills(all(), { view: preferences.view, active: activeNames() })
      .filter(matches)
      .sort((a, b) => {
        const core = Number(coreSkill(b)) - Number(coreSkill(a))
        return core || (coreSkill(a) ? compareCore(a, b) : a.name.localeCompare(b.name))
      }),
  )

  // Sections carry the empty-search browse; a search or the Off view is a
  // flat list so every match is in view at once.
  const flat = createMemo(() => !!query() || preferences.view === "off")
  const core = createMemo(() => filtered().filter(coreSkill))
  const personal = createMemo(() => filtered().filter((skill) => !coreSkill(skill) && skillSource(skill) !== "default"))
  const shelves = createMemo(() => {
    const by = new Map<string, Skill[]>()
    for (const skill of filtered()) {
      if (coreSkill(skill) || skillSource(skill) !== "default") continue
      const category = skill.category ?? "other"
      if (!by.has(category)) by.set(category, [])
      by.get(category)!.push(skill)
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })
  const counts = createMemo(() => ({
    core: all().filter(coreSkill).length,
    library: all().filter((skill) => !coreSkill(skill) && skillSource(skill) === "default").length,
    personal: all().filter((skill) => skillSource(skill) !== "default").length,
    off: all().length - enabledCount(),
  }))
  const visibleFlat = createMemo(() => filtered().slice(0, flatRows()))

  const shelfOpen = (category: string) => openShelves().has(category)
  const toggleShelf = (category: string) =>
    setOpenShelves((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })

  createEffect(() => {
    all().length
    query()
    preferences.view
    setFlatRows(FLAT_ROWS)
  })

  onMount(() => {
    const updatePreferences = () => setPinned(skillPreferences(storage).pinned)
    globalThis.addEventListener(SKILL_PREFERENCES_EVENT, updatePreferences)
    onCleanup(() => globalThis.removeEventListener(SKILL_PREFERENCES_EVENT, updatePreferences))
  })

  const row = (skill: Skill, subject?: boolean) => (
    <SkillRow
      skill={skill}
      on={enabled(skill.name)}
      pinned={pinnedNames().has(skill.name)}
      saving={Boolean(permissionPending()[skill.name])}
      action={catalog().action(skill.name)}
      quietAsk={asksEverywhere()}
      disabled={skills.loading || !!skills.error}
      subject={subject && !coreSkill(skill) ? displayLabel(skill.category ?? "other") : undefined}
      onToggle={(value) => toggle([skill.name], value)}
      onPin={(value) => {
        setSkillPinned(skill.name, value, storage)
        setPinned(skillPreferences(storage).pinned)
      }}
      onEdit={skillSource(skill) === "user" ? () => setForm({ kind: "edit", name: skill.name }) : undefined}
      onDelete={skillSource(skill) === "user" ? () => void removeSkill(skill.name) : undefined}
    />
  )

  const activatable = (items: Skill[]) =>
    items
      .filter(
        (skill) =>
          !enabled(skill.name) &&
          skill.disabled_by !== "project" &&
          catalog().action(skill.name) !== "deny" &&
          skill.catalog_status !== "blocked",
      )
      .map((skill) => skill.name)
  const deactivatable = (items: Skill[]) => items.filter((skill) => enabled(skill.name)).map((skill) => skill.name)

  return (
    <div class="skills-workspace" data-layout={props.embedded ? "settings" : "workspace"}>
      <div class="skills-workspace__header">
        <div class="skills-workspace__heading">
          <div class="skills-workspace__heading-copy">
            <Show when={!props.embedded} fallback={<h2>{language.t("atlas.skills.title")}</h2>}>
              <h1>{language.t("atlas.skills.title")}</h1>
            </Show>
            <p>{language.t("atlas.skills.description")}</p>
          </div>
          <div class="skills-workspace__summary" aria-live="polite">
            <span>{language.t("atlas.skills.activeCount", { count: enabledCount() })}</span>
            <span aria-hidden="true">·</span>
            <span>{language.t("atlas.skills.libraryCount", { count: all().length })}</span>
            <Show when={asksEverywhere()}>
              <span aria-hidden="true">·</span>
              <span title={language.t("atlas.skills.askDescription")}>{language.t("atlas.skills.askFirst")}</span>
            </Show>
          </div>
        </div>

        <Show when={form().kind === "list"}>
          <div class="skills-workspace__toolbar">
            <div class="skills-workspace__views" role="group" aria-label={language.t("atlas.skills.views")}>
              <For
                each={
                  [
                    { id: "all", label: language.t("atlas.skills.all"), count: all().length },
                    { id: "core", label: language.t("atlas.skills.core"), count: counts().core },
                    { id: "library", label: language.t("atlas.skills.library"), count: counts().library },
                    { id: "personal", label: language.t("atlas.skills.personal"), count: counts().personal },
                    { id: "off", label: language.t("atlas.skills.off"), count: counts().off },
                  ] as const
                }
              >
                {(tab) => (
                  <button
                    type="button"
                    aria-pressed={preferences.view === tab.id}
                    onClick={() => setPreferences("view", tab.id)}
                  >
                    {tab.label}
                    <span>{tab.count}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="settings-toolbar skills-workspace__toolbar-controls">
              <SearchInput
                value={search()}
                onInput={setSearch}
                placeholder={language.t("atlas.skills.search")}
                ariaLabel={language.t("atlas.skills.search")}
              />
              <AddMenu
                label={language.t("atlas.skills.add")}
                items={[
                  {
                    icon: "pencil-line",
                    label: language.t("atlas.skills.scratch"),
                    description: language.t("atlas.skills.scratchHint"),
                    onSelect: () => setForm({ kind: "scratch" }),
                  },
                  {
                    icon: "cloud-upload",
                    label: language.t("atlas.skills.upload"),
                    description: language.t("atlas.skills.uploadHint"),
                    onSelect: () => fileInput?.click(),
                  },
                  {
                    icon: "folder",
                    label: language.t("atlas.skills.folder"),
                    description: language.t("atlas.skills.folderHint"),
                    onSelect: () => setForm({ kind: "folder" }),
                  },
                  {
                    icon: "github",
                    label: language.t("atlas.skills.github"),
                    description: language.t("atlas.skills.githubHint"),
                    onSelect: () => setForm({ kind: "github" }),
                  },
                ]}
              />
            </div>
            <Show when={preferences.feedback}>
              <p class="skills-workspace__feedback" role="status">
                {preferences.feedback}
              </p>
            </Show>
          </div>
        </Show>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".md,text/markdown"
        class="hidden"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ""
          if (file) void uploadSkill(file)
        }}
      />

      <div class="atlas-scroll skills-workspace__body">
        <div class="skills-workspace__content">
          <Branch>
            <Match when={form().kind === "scratch"}>
              <ScratchForm
                busy={busy()}
                onCancel={() => setForm({ kind: "list" })}
                onCreate={async (name, description, body) => {
                  await save(name, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "created")
                }}
              />
            </Match>
            <Match when={form().kind === "edit" ? (form() as { name: string }).name : undefined}>
              {(name) => (
                <EditForm
                  name={name()}
                  busy={busy()}
                  load={() => service.read(name())}
                  onCancel={() => setForm({ kind: "list" })}
                  onSave={(content) => save(name(), content, "saved")}
                />
              )}
            </Match>
            <Match when={form().kind === "github"}>
              <GithubForm
                busy={busy()}
                onCancel={() => setForm({ kind: "list" })}
                onInstall={async (url) => {
                  setBusy(true)
                  try {
                    const res = await service.install(url)
                    refresh()
                    const n = res.installed.length
                    const r = res.rejected.length
                    showToast({
                      variant: n > 0 ? "success" : "error",
                      title:
                        n > 0
                          ? language.t("atlas.skills.installedCount", { count: n })
                          : language.t("atlas.skills.installEmpty"),
                      description: r > 0 ? language.t("atlas.skills.rejectedCount", { count: r }) : undefined,
                    })
                    if (n > 0) setForm({ kind: "list" })
                  } catch (err) {
                    showToast({
                      variant: "error",
                      title: language.t("atlas.skills.installError"),
                      description: message(err),
                    })
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            </Match>
            <Match when={form().kind === "folder"}>
              <FolderForm
                busy={busy()}
                onCancel={() => setForm({ kind: "list" })}
                onAdd={async (path, persist) => {
                  setBusy(true)
                  try {
                    const root = await service.addRoot(path, persist)
                    refresh()
                    showToast({
                      variant: "success",
                      title: language.t("atlas.skills.addedCount", { count: root.skills, path: shortPath(root.path) }),
                    })
                    setForm({ kind: "list" })
                  } catch (err) {
                    showToast({
                      variant: "error",
                      title: language.t("atlas.skills.addFolderError"),
                      description: message(err),
                    })
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            </Match>
            <Match when={form().kind === "list"}>
              <Show when={skills.error && all().length > 0}>
                <div class="skills-workspace__catalog-warning" role="alert">
                  <span>{language.t("atlas.skills.cached")}</span>
                  <button type="button" onClick={refresh}>
                    {language.t("atlas.common.retry")}
                  </button>
                </div>
              </Show>
              <Show
                when={!skills.loading || all().length > 0}
                fallback={
                  <div class="skills-workspace__loading" role="status" aria-live="polite">
                    <AtomLoader size={144} caption={language.t("atlas.skills.loading")} />
                  </div>
                }
              >
                <Show
                  when={!skills.error || all().length > 0}
                  fallback={
                    <CatalogState
                      icon="alert-circle"
                      title={language.t("atlas.skills.loadError")}
                      hint={message(skills.error)}
                      action={language.t("atlas.common.tryAgain")}
                      onAction={refresh}
                    />
                  }
                >
                  <Show
                    when={filtered().length > 0}
                    fallback={
                      <Show
                        when={!!query() || preferences.view !== "all"}
                        fallback={
                          <EmptyState
                            icon="brain"
                            title={language.t("atlas.skills.empty")}
                            hint={language.t("atlas.skills.emptyHint")}
                          />
                        }
                      >
                        <CatalogState
                          icon="magnifying-glass"
                          title={language.t("atlas.skills.noMatches")}
                          hint={language.t("atlas.skills.noMatchesHint")}
                          action={language.t("atlas.skills.clearSearch")}
                          onAction={() => {
                            setSearch("")
                            setPreferences("view", "all")
                          }}
                        />
                      </Show>
                    }
                  >
                    <Show
                      when={!flat()}
                      fallback={
                        <section class="skills-workspace__group" aria-label={language.t("atlas.skills.matches")}>
                          <ul class="skills-workspace__rows">
                            <For each={visibleFlat()}>{(skill) => row(skill, true)}</For>
                          </ul>
                          <Show when={flatRows() < filtered().length}>
                            <button
                              type="button"
                              class="skills-workspace__more"
                              onClick={() => setFlatRows((current) => current + FLAT_ROWS)}
                            >
                              {language.t("atlas.skills.more")}
                            </button>
                          </Show>
                        </section>
                      }
                    >
                      <div class="skills-workspace__list">
                        <Show when={core().length > 0}>
                          <section class="skills-workspace__group" aria-labelledby="skills-group-core">
                            <div class="skills-workspace__group-heading">
                              <h3 id="skills-group-core">{language.t("atlas.skills.core")}</h3>
                              <p>{language.t("atlas.skills.coreHint")}</p>
                            </div>
                            <ul class="skills-workspace__rows">
                              <For each={core()}>{(skill) => row(skill)}</For>
                            </ul>
                          </section>
                        </Show>

                        <Show when={personal().length > 0}>
                          <section class="skills-workspace__group" aria-labelledby="skills-group-personal">
                            <div class="skills-workspace__group-heading">
                              <h3 id="skills-group-personal">{language.t("atlas.skills.personal")}</h3>
                              <p>{language.t("atlas.skills.personalHint")}</p>
                            </div>
                            <ul class="skills-workspace__rows">
                              <For each={personal()}>{(skill) => row(skill)}</For>
                            </ul>
                          </section>
                        </Show>

                        <Show when={shelves().length > 0}>
                          <section class="skills-workspace__group" aria-labelledby="skills-group-library">
                            <div class="skills-workspace__group-heading">
                              <h3 id="skills-group-library">{language.t("atlas.skills.library")}</h3>
                              <p>{language.t("atlas.skills.libraryHint")}</p>
                            </div>
                            <div class="skills-workspace__shelves">
                              <For each={shelves()}>
                                {([category, items]) => {
                                  const on = () => items.filter((skill) => enabled(skill.name)).length
                                  return (
                                    <section
                                      class="skills-workspace__shelf"
                                      data-open={shelfOpen(category) ? "true" : "false"}
                                      aria-label={displayLabel(category)}
                                    >
                                      <div class="skills-workspace__shelf-head">
                                        <button
                                          type="button"
                                          class="skills-workspace__shelf-toggle"
                                          aria-expanded={shelfOpen(category)}
                                          onClick={() => toggleShelf(category)}
                                        >
                                          <Icon name="chevron-right" size="small" />
                                          <span class="skills-workspace__skill-icon" aria-hidden="true">
                                            <Icon name={skillIconFor({ name: category, category })} size="small" />
                                          </span>
                                          <strong>{displayLabel(category)}</strong>
                                          <span>
                                            {language.t("atlas.skills.count", { count: items.length })}
                                            <Show
                                              when={on() < items.length}
                                            >{` · ${language.t("atlas.skills.offCount", { count: items.length - on() })}`}</Show>
                                          </span>
                                        </button>
                                        <div class="skills-workspace__shelf-actions">
                                          <Show
                                            when={on() < items.length}
                                            fallback={
                                              <button
                                                type="button"
                                                disabled={
                                                  !deactivatable(items).length || skills.loading || !!skills.error
                                                }
                                                onClick={() => toggle(deactivatable(items), false)}
                                              >
                                                {language.t("atlas.skills.offAll")}
                                              </button>
                                            }
                                          >
                                            <button
                                              type="button"
                                              disabled={!activatable(items).length || skills.loading || !!skills.error}
                                              onClick={() => toggle(activatable(items), true)}
                                            >
                                              {language.t("atlas.skills.activateAll")}
                                            </button>
                                          </Show>
                                        </div>
                                      </div>
                                      <Show when={shelfOpen(category)}>
                                        <ul class="skills-workspace__rows">
                                          <For each={items}>{(skill) => row(skill)}</For>
                                        </ul>
                                      </Show>
                                    </section>
                                  )
                                }}
                              </For>
                            </div>
                          </section>
                        </Show>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </Show>

              <Show when={!flat() && preferences.view === "all" && roots()}>
                {(sources) => (
                  <section
                    class="skills-workspace__group skills-workspace__sources"
                    aria-labelledby="skills-group-sources"
                  >
                    <div class="skills-workspace__group-heading">
                      <h3 id="skills-group-sources">{language.t("atlas.skills.sources")}</h3>
                      <p>{language.t("atlas.skills.sourcesHint")}</p>
                    </div>
                    <ul class="skills-workspace__rows">
                      <For each={sources().roots}>
                        {(root) => (
                          <li class="skills-workspace__source" data-kind={root.kind}>
                            <span class="skills-workspace__skill-icon" aria-hidden="true">
                              <Icon name={root.kind === "bundled" ? "archive" : "folder"} size="small" />
                            </span>
                            <div class="skills-workspace__source-copy">
                              <strong>{rootLabels()[root.kind]}</strong>
                              <code title={root.path}>{shortPath(root.path)}</code>
                            </div>
                            <span class="skills-workspace__source-count">
                              {language.t("atlas.skills.count", { count: root.skills })}
                              <Show
                                when={root.shadowed > 0}
                              >{` · ${language.t("atlas.skills.shadowedCount", { count: root.shadowed })}`}</Show>
                            </span>
                            <Show when={root.kind === "runtime" || root.kind === "config"}>
                              <button
                                type="button"
                                class="skills-workspace__source-remove"
                                aria-label={language.t("atlas.skills.removeNamed", { name: root.path })}
                                title={language.t("atlas.skills.removeSource")}
                                onClick={() => void removeRoot(root)}
                              >
                                <Icon name="trash" size="small" />
                              </button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={sources().shadowed.length > 0}>
                      <ul class="skills-workspace__shadowed" aria-label={language.t("atlas.skills.shadowed")}>
                        <For each={sources().shadowed}>
                          {(entry) => (
                            <li>
                              {language.t("atlas.skills.shadowedBy", {
                                name: entry.name,
                                location: shortPath(entry.location),
                                source: shortPath(entry.by),
                              })}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                )}
              </Show>
            </Match>
          </Branch>
        </div>
      </div>
    </div>
  )

  async function save(name: string, content: string, verb: "created" | "saved") {
    setBusy(true)
    try {
      await service.create(name, content)
      refresh()
      showToast({
        variant: "success",
        title:
          verb === "created"
            ? language.t("atlas.skills.created", { name })
            : language.t("atlas.skills.saved", { name }),
      })
      setForm({ kind: "list" })
    } catch (err) {
      showToast({ variant: "error", title: language.t("atlas.skills.saveError"), description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function removeSkill(name: string) {
    if (typeof confirm === "function" && !confirm(language.t("atlas.skills.confirmDelete", { name }))) return
    try {
      await service.remove(name)
      refresh()
      showToast({ variant: "success", title: language.t("atlas.skills.deleted", { name }) })
    } catch (err) {
      showToast({ variant: "error", title: language.t("atlas.skills.deleteError"), description: message(err) })
    }
  }

  async function removeRoot(root: SkillRoot) {
    try {
      await service.removeRoot(root.path, root.kind === "config" ? "global" : undefined)
      refresh()
      showToast({ variant: "success", title: language.t("atlas.skills.removed", { path: shortPath(root.path) }) })
    } catch (err) {
      showToast({ variant: "error", title: language.t("atlas.skills.removeFolderError"), description: message(err) })
    }
  }

  async function uploadSkill(file: File) {
    setBusy(true)
    try {
      const content = await file.text()
      const name = frontmatterName(content)
      if (!name) {
        throw new Error(language.t("atlas.skills.frontmatterError"))
      }
      await service.create(name, content)
      refresh()
      showToast({ variant: "success", title: language.t("atlas.skills.uploaded", { name }) })
    } catch (err) {
      showToast({ variant: "error", title: language.t("atlas.skills.uploadError"), description: message(err) })
    } finally {
      setBusy(false)
    }
  }
}

function SkillRow(props: {
  skill: Skill
  on: boolean
  pinned: boolean
  saving: boolean
  action: "allow" | "ask" | "deny"
  quietAsk?: boolean
  disabled: boolean
  subject?: string
  onToggle: (v: boolean) => void
  onPin: (v: boolean) => void
  onEdit?: () => void
  onDelete?: () => void
}): JSX.Element {
  const language = useLanguage()
  const sourceLabels = (): Record<SkillSource, string> => ({
    default: language.t("atlas.skills.source.default"),
    installed: language.t("atlas.skills.source.installed"),
    user: language.t("atlas.skills.personal"),
    project: language.t("atlas.skills.source.project"),
  })

  const source = () => skillSource(props.skill)
  const blocked = () => props.skill.catalog_status === "blocked" || props.action === "deny"
  const state = () => {
    if (props.skill.disabled_by === "project") return language.t("atlas.skills.offProject")
    if (blocked()) return language.t("atlas.skills.blocked")
    if (props.on && props.action === "ask" && !props.quietAsk) return language.t("atlas.skills.askFirst")
    return undefined
  }
  return (
    <li
      class="skills-workspace__row"
      data-enabled={props.on ? "true" : "false"}
      data-source={source()}
      data-saving={props.saving ? "true" : undefined}
      aria-busy={props.saving ? "true" : undefined}
    >
      <span class="skills-workspace__skill-icon" aria-hidden="true">
        <Icon name={skillIconFor(props.skill)} size="small" />
      </span>
      <div class="skills-workspace__identity">
        <strong title={props.skill.name}>{displayLabel(props.skill.name)}</strong>
        <span>
          <code>/{props.skill.name}</code>
          <Show when={source() !== "default"}>
            <span aria-hidden="true">·</span>
            {sourceLabels()[source()]}
          </Show>
          <Show when={props.subject}>
            <span aria-hidden="true">·</span>
            {props.subject}
          </Show>
        </span>
      </div>
      <div class="skills-workspace__details" title={props.skill.description}>
        <span class="skills-workspace__details-slug">/{props.skill.name}</span>
        {blurb(props.skill) || language.t("atlas.skills.noDescription")}
      </div>
      <Show when={state()}>
        {(value) => (
          <span
            class="skills-workspace__state"
            data-state={blocked() || props.skill.disabled_by === "project" ? "blocked" : "ask"}
            title={
              props.action === "ask"
                ? language.t("atlas.skills.askSkill")
                : props.action === "deny"
                  ? language.t("atlas.skills.denied")
                  : undefined
            }
          >
            {value()}
          </span>
        )}
      </Show>
      <div class="skills-workspace__actions">
        <Show when={props.onEdit}>
          <button
            type="button"
            aria-label={language.t("atlas.skills.editNamed", { name: props.skill.name })}
            title={language.t("common.edit")}
            onClick={props.onEdit}
          >
            <Icon name="pencil-line" size="small" />
          </button>
        </Show>
        <Show when={props.onDelete}>
          <button
            type="button"
            aria-label={language.t("atlas.skills.deleteNamed", { name: props.skill.name })}
            title={language.t("common.delete")}
            onClick={props.onDelete}
          >
            <Icon name="trash" size="small" />
          </button>
        </Show>
        <button
          type="button"
          class="skills-workspace__pin"
          data-pinned={props.pinned ? "true" : "false"}
          aria-pressed={props.pinned}
          aria-label={
            props.pinned
              ? language.t("atlas.skills.unpinNamed", { name: props.skill.name })
              : language.t("atlas.skills.pinNamed", { name: props.skill.name })
          }
          title={props.pinned ? language.t("atlas.skills.unpinHint") : language.t("atlas.skills.pinHint")}
          onClick={() => props.onPin(!props.pinned)}
        >
          <Icon name={props.pinned ? "pin-filled" : "pin"} size="small" />
        </button>
        <Switch
          data-action="skill-toggle"
          checked={props.on}
          onChange={props.onToggle}
          disabled={props.disabled || blocked() || props.skill.disabled_by === "project"}
          hideLabel
        >
          {props.on
            ? language.t("atlas.skills.offNamed", { name: props.skill.name })
            : language.t("atlas.skills.activateNamed", { name: props.skill.name })}
        </Switch>
      </div>
    </li>
  )
}

function FormShell(props: {
  icon: "pencil-line" | "github" | "folder"
  title: string
  hint: string
  children: JSX.Element
}) {
  return (
    <div class="skills-workspace__form">
      <div class="skills-workspace__form-heading">
        <div class="skills-workspace__form-icon" aria-hidden="true">
          <Icon name={props.icon} size="small" />
        </div>
        <div>
          <h3>{props.title}</h3>
          <p>{props.hint}</p>
        </div>
      </div>
      <div class="skills-workspace__form-fields">{props.children}</div>
    </div>
  )
}

function ScratchForm(props: {
  busy: boolean
  onCancel: () => void
  onCreate: (name: string, description: string, body: string) => void
}): JSX.Element {
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const valid = () => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name().trim()) && description().trim().length > 0
  return (
    <FormShell icon="pencil-line" title={language.t("atlas.skills.new")} hint={language.t("atlas.skills.newHint")}>
      <FormField
        label={language.t("atlas.common.name")}
        value={name()}
        onInput={setName}
        placeholder={language.t("atlas.skills.namePlaceholder")}
      />
      <FormField
        label={language.t("atlas.common.description")}
        value={description()}
        onInput={setDescription}
        placeholder={language.t("atlas.skills.descriptionPlaceholder")}
      />
      <FormField
        label={language.t("atlas.skills.instructions")}
        value={body()}
        onInput={setBody}
        multiline
        mono
        placeholder={language.t("atlas.skills.instructionsPlaceholder")}
      />
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? language.t("atlas.skills.creating") : language.t("atlas.skills.create")}
          disabled={props.busy || !valid()}
          onClick={() => props.onCreate(name().trim(), description().trim(), body())}
        />
        <FormButton
          label={language.t("common.cancel")}
          variant="ghost"
          onClick={props.onCancel}
          disabled={props.busy}
        />
      </div>
    </FormShell>
  )
}

function EditForm(props: {
  name: string
  busy: boolean
  load: () => Promise<string>
  onCancel: () => void
  onSave: (content: string) => void
}): JSX.Element {
  const language = useLanguage()
  const [content] = createResource(() => props.load())
  const [draft, setDraft] = createSignal<string>()
  const text = () => draft() ?? content() ?? ""
  return (
    <FormShell
      icon="pencil-line"
      title={language.t("atlas.skills.editCommand", { name: props.name })}
      hint={language.t("atlas.skills.editHint")}
    >
      <Show
        when={!content.loading}
        fallback={<p class="skills-workspace__form-note">{language.t("atlas.common.loading")}</p>}
      >
        <Show when={!content.error} fallback={<p class="skills-workspace__form-note">{message(content.error)}</p>}>
          <FormField label="SKILL.md" value={text()} onInput={setDraft} multiline mono />
        </Show>
      </Show>
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? language.t("atlas.common.saving") : language.t("atlas.skills.save")}
          disabled={props.busy || content.loading || !!content.error || !text().trim()}
          onClick={() => props.onSave(text())}
        />
        <FormButton
          label={language.t("common.cancel")}
          variant="ghost"
          onClick={props.onCancel}
          disabled={props.busy}
        />
      </div>
    </FormShell>
  )
}

function GithubForm(props: { busy: boolean; onCancel: () => void; onInstall: (url: string) => void }): JSX.Element {
  const language = useLanguage()
  const [url, setUrl] = createSignal("")
  return (
    <FormShell icon="github" title={language.t("atlas.skills.github")} hint={language.t("atlas.skills.importHint")}>
      <FormField
        label={language.t("atlas.skills.repository")}
        value={url()}
        onInput={setUrl}
        placeholder="https://github.com/owner/repo"
      />
      <p class="skills-workspace__form-note">
        <Icon name="shield" size="small" />
        {language.t("atlas.skills.securityReview")}
      </p>
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? language.t("atlas.skills.installing") : language.t("atlas.common.install")}
          disabled={props.busy || !url().trim()}
          onClick={() => props.onInstall(url().trim())}
        />
        <FormButton
          label={language.t("common.cancel")}
          variant="ghost"
          onClick={props.onCancel}
          disabled={props.busy}
        />
      </div>
    </FormShell>
  )
}

function FolderForm(props: {
  busy: boolean
  onCancel: () => void
  onAdd: (path: string, persist?: "global" | "project") => void
}): JSX.Element {
  const language = useLanguage()
  const [path, setPath] = createSignal("")
  const [persist, setPersist] = createSignal<"session" | "global" | "project">("global")
  return (
    <FormShell icon="folder" title={language.t("atlas.skills.folder")} hint={language.t("atlas.skills.localHint")}>
      <FormField
        label={language.t("atlas.files.folderPath")}
        value={path()}
        onInput={setPath}
        placeholder={language.t("atlas.skills.folderPlaceholder")}
        mono
      />
      <label class="skills-workspace__form-choice">
        <span>{language.t("atlas.skills.keep")}</span>
        <select
          aria-label={language.t("atlas.skills.keepDuration")}
          value={persist()}
          onChange={(event) => setPersist(event.currentTarget.value as "session" | "global" | "project")}
        >
          <option value="global">{language.t("atlas.skills.keepGlobal")}</option>
          <option value="project">{language.t("atlas.skills.keepProject")}</option>
          <option value="session">{language.t("atlas.skills.keepSession")}</option>
        </select>
      </label>
      <p class="skills-workspace__form-note">
        <Icon name="shield" size="small" />
        {language.t("atlas.skills.folderPriority")}
      </p>
      <div class="skills-workspace__form-actions">
        <FormButton
          label={props.busy ? language.t("atlas.skills.adding") : language.t("atlas.skills.addFolder")}
          disabled={props.busy || !path().trim()}
          onClick={() => {
            const scope = persist()
            props.onAdd(path().trim(), scope === "session" ? undefined : scope)
          }}
        />
        <FormButton
          label={language.t("common.cancel")}
          variant="ghost"
          onClick={props.onCancel}
          disabled={props.busy}
        />
      </div>
    </FormShell>
  )
}

function CatalogState(props: {
  icon: "alert-circle" | "magnifying-glass"
  title: string
  hint: string
  action?: string
  onAction?: () => void
}): JSX.Element {
  return (
    <div class="skills-workspace__empty" role={props.icon === "alert-circle" ? "alert" : "status"}>
      <div class="settings-empty-state__icon skills-workspace__empty-icon" aria-hidden="true">
        <Icon name={props.icon} size="normal" />
      </div>
      <strong>{props.title}</strong>
      <p>{props.hint}</p>
      <Show when={props.action && props.onAction}>
        <button type="button" class="settings-button" data-variant="ghost" onClick={props.onAction}>
          {props.action}
        </button>
      </Show>
    </div>
  )
}

export function shortPath(value: string) {
  const home = typeof value === "string" && value.match(/^\/(?:Users|home)\/[^/]+/)
  const short = home ? `~${value.slice(home[0].length)}` : value
  return short.length > 60 ? `…${short.slice(-58)}` : short
}

function frontmatterName(content: string): string | undefined {
  const match = content.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/)
  if (!match) return undefined
  const line = match[1].split(/\r?\n/).find((l) => /^name\s*:/.test(l))
  return line
    ?.split(":")
    .slice(1)
    .join(":")
    .trim()
    .replace(/^["']|["']$/g, "")
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
