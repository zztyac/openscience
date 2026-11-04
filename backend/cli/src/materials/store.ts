import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  MaterialActivity,
  MaterialActivitySnapshot,
  MaterialActivityUpdate,
  MaterialCreate,
  MaterialProject,
  MaterialStage,
  MaterialStatus,
  materialStages,
} from "@synsci/util/materials"
import type z from "zod"

export type MaterialBinding = { sessionID: string }

export class MaterialError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413 | 422 | 503,
    message: string,
  ) {
    super(message)
    this.name = "MaterialError"
  }
}

export function materialID(prefix = "mat") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}

export function materialEvent(project: MaterialProject, message: string, kind: "info" | "error" | "decision" = "info") {
  project.events.push({ id: materialID("evt"), createdAt: Date.now(), message, kind })
}

type Row = { json: string; revision: number }
type Lease = { owner: string; pid: number; host: string; expires: number }
type ActivityRow = { token: string | null; json: string }
type ActivityEnd = "completed" | "failed" | "cancelled" | "interrupted"

/** Project snapshots, immutable artifacts and their events share one SQLite transaction. */
export class MaterialsStore {
  readonly db: Database
  readonly owner = crypto.randomUUID()
  private closed = false
  onChange?: (project: MaterialProject) => void

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.db = new Database(path.join(directory, "materials.sqlite"), { create: true, strict: true })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request_json TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT UNIQUE NOT NULL REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS scheduler (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_runs (project_id TEXT PRIMARY KEY REFERENCES projects(id), token TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_events_project ON activity_events(project_id,seq);`)
    // Older snapshots predate the lightweight status projection used by frequent activity polling.
    this.db
      .transaction(() => {
        if (
          !this.db
            .query<{ name: string }, []>("PRAGMA table_info(projects)")
            .all()
            .some((column) => column.name === "status")
        ) {
          this.db.exec("ALTER TABLE projects ADD COLUMN status TEXT")
          this.db.exec("UPDATE projects SET status=json_extract(json,'$.status')")
        }
      })
      .immediate()
  }

  list(): MaterialProject[] {
    return this.db
      .query<{ json: string }, []>("SELECT json FROM projects ORDER BY rowid DESC")
      .all()
      .map((row) => MaterialProject.parse(JSON.parse(row.json)))
  }

  get(id: string): MaterialProject {
    if (!/^mat_[a-f0-9]{32}$/.test(id)) throw new MaterialError(404, "科研项目不存在")
    const row = this.db.query<Row, [string]>("SELECT json, revision FROM projects WHERE id=?").get(id)
    if (!row) throw new MaterialError(404, "科研项目不存在")
    return MaterialProject.parse(JSON.parse(row.json))
  }

  activity(id: string): MaterialActivitySnapshot {
    const project = this.state(id)
    const row = this.db.query<ActivityRow, [string]>("SELECT token,json FROM activity_runs WHERE project_id=?").get(id)
    const events = this.db
      .query<{ json: string }, [string]>("SELECT json FROM activity_events WHERE project_id=? ORDER BY seq")
      .all(id)
    return {
      projectID: id,
      ...project,
      serverTime: Date.now(),
      ...(row ? { current: MaterialActivity.parse(JSON.parse(row.json)) } : {}),
      events: events.map((event) => MaterialActivitySnapshot.shape.events.element.parse(JSON.parse(event.json))),
    }
  }

  beginActivity(id: string, stage: MaterialStage) {
    return this.db
      .transaction(() => {
        if (this.state(id).status !== "running" || !this.owns()) return undefined
        const token = crypto.randomUUID()
        const now = Date.now()
        this.writeActivity(id, token, { stage, phase: "preparing", startedAt: now, updatedAt: now }, true)
        return token
      })
      .immediate()
  }

  reportActivity(id: string, token: string, input: MaterialActivityUpdate, receivedAt = Date.now()) {
    if (this.closed) return
    const update = MaterialActivityUpdate.parse(input)
    return this.db
      .transaction(() => {
        const row = this.db
          .query<ActivityRow, [string]>("SELECT token,json FROM activity_runs WHERE project_id=?")
          .get(id)
        if (row?.token !== token || this.state(id).status !== "running" || !this.owns()) return
        const previous = MaterialActivity.parse(JSON.parse(row.json))
        const roleChanged = update.role !== undefined && update.role !== previous.role
        // Resolving the model can enrich the same preparation event after the operation has started.
        const fresh =
          roleChanged || (["preparing", "repairing"].includes(update.phase) && update.phase !== previous.phase)
        const now = Date.now()
        const current: MaterialActivity = {
          ...(roleChanged
            ? {}
            : fresh
              ? { role: previous.role, model: previous.model, step: previous.step, steps: previous.steps }
              : previous),
          ...update,
          stage: previous.stage,
          startedAt: fresh ? now : previous.startedAt,
          updatedAt: now,
          ...(["reasoning", "generating"].includes(update.phase) ? { lastModelActivityAt: receivedAt } : {}),
        }
        const milestone =
          ["phase", "role", "step", "item"].some(
            (key) => previous[key as keyof MaterialActivity] !== current[key as keyof MaterialActivity],
          ) || fresh
        this.writeActivity(id, token, current, milestone)
      })
      .immediate()
  }

  finishActivity(id: string, token: string, phase: ActivityEnd) {
    if (this.closed) return
    this.db
      .transaction(() => {
        const row = this.db
          .query<ActivityRow, [string]>("SELECT token,json FROM activity_runs WHERE project_id=?")
          .get(id)
        if (row?.token !== token || !this.owns()) return
        this.writeActivity(
          id,
          null,
          { ...MaterialActivity.parse(JSON.parse(row.json)), phase, updatedAt: Date.now() },
          true,
        )
      })
      .immediate()
  }

  private state(id: string) {
    if (!/^mat_[a-f0-9]{32}$/.test(id)) throw new MaterialError(404, "科研项目不存在")
    const row = this.db
      .query<{ revision: number; status: string }, [string]>("SELECT revision,status FROM projects WHERE id=?")
      .get(id)
    if (!row) throw new MaterialError(404, "科研项目不存在")
    return { revision: row.revision, status: MaterialStatus.parse(row.status) }
  }

  private writeActivity(id: string, token: string | null, current: MaterialActivity, milestone: boolean) {
    this.db
      .query("INSERT OR REPLACE INTO activity_runs (project_id,token,json) VALUES (?,?,?)")
      .run(id, token, JSON.stringify(current))
    if (!milestone) return
    const event = { ...current, id: materialID("act") }
    this.db
      .query("INSERT INTO activity_events (id,project_id,json) VALUES (?,?,?)")
      .run(event.id, id, JSON.stringify(event))
    this.db
      .query(
        "DELETE FROM activity_events WHERE project_id=? AND seq NOT IN (SELECT seq FROM activity_events WHERE project_id=? ORDER BY seq DESC LIMIT 200)",
      )
      .run(id, id)
  }

  projectDirectory(id: string) {
    this.get(id)
    const directory = path.join(this.directory, "projects", id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  create(input: z.input<typeof MaterialCreate>, binding?: MaterialBinding): MaterialProject {
    const parsed = MaterialCreate.parse(input)
    const sessionID = binding ? MaterialProject.shape.sessionID.unwrap().parse(binding.sessionID) : undefined
    const request = JSON.stringify(sessionID ? { ...parsed, sessionID } : parsed)
    const result = this.db
      .transaction(() => {
        const old = this.db
          .query<{ id: string; request_json: string }, [string]>(
            "SELECT id, request_json FROM projects WHERE request_id=?",
          )
          .get(parsed.requestID)
        if (old) {
          if (old.request_json !== request) throw new MaterialError(409, "该请求编号已用于另一个课题，请刷新后重试")
          return this.get(old.id)
        }
        const now = Date.now()
        const project: MaterialProject = {
          id: materialID(),
          workspaceID: "default",
          ...(sessionID ? { sessionID } : {}),
          title: parsed.title || parsed.goal.slice(0, 80),
          goal: parsed.goal,
          domain: "rebco",
          target: parsed.target,
          status: "queued",
          revision: 0,
          createdAt: now,
          updatedAt: now,
          answers: "",
          questions: [],
          stages: materialStages.map((key) => ({ key, status: "pending" })),
          sources: [],
          artifacts: [],
          batches: [],
          events: [],
          selectedIdeaIDs: [],
          model: parsed.model,
        }
        materialEvent(project, "课题已创建，等待服务器执行")
        this.db
          .query("INSERT INTO projects (id,request_id,request_json,revision,json,status) VALUES (?,?,?,?,?,?)")
          .run(project.id, parsed.requestID, request, project.revision, JSON.stringify(project), project.status)
        this.db
          .query("INSERT INTO events (id,project_id,json) VALUES (?,?,?)")
          .run(project.events[0].id, project.id, JSON.stringify(project.events[0]))
        this.db.query("INSERT INTO jobs (project_id) VALUES (?)").run(project.id)
        return project
      })
      .immediate()
    this.onChange?.(structuredClone(result))
    return result
  }

  update(id: string, revision: number | undefined, mutate: (project: MaterialProject) => void): MaterialProject {
    const result = this.db
      .transaction(() => {
        const previous = this.get(id)
        if (revision !== undefined && previous.revision !== revision)
          throw new MaterialError(409, "课题已更新，请刷新后重试")
        const project = structuredClone(previous)
        mutate(project)
        if (
          project.id !== previous.id ||
          project.workspaceID !== previous.workspaceID ||
          project.sessionID !== previous.sessionID ||
          project.createdAt !== previous.createdAt
        )
          throw new Error("Immutable project identity changed")
        for (const key of ["artifacts", "events", "batches"] as const) {
          if (JSON.stringify(project[key].slice(0, previous[key].length)) !== JSON.stringify(previous[key]))
            throw new Error(`Immutable ${key} changed`)
        }
        project.revision = previous.revision + 1
        project.updatedAt = Date.now()
        MaterialProject.parse(project)
        const changed = this.db
          .query("UPDATE projects SET revision=?,json=?,status=? WHERE id=? AND revision=?")
          .run(project.revision, JSON.stringify(project), project.status, id, previous.revision)
        if (!changed.changes) throw new MaterialError(409, "课题已更新，请刷新后重试")
        for (const artifact of project.artifacts.slice(previous.artifacts.length))
          this.db
            .query("INSERT INTO artifacts (id,project_id,json) VALUES (?,?,?)")
            .run(artifact.id, id, JSON.stringify(artifact))
        for (const event of project.events.slice(previous.events.length))
          this.db
            .query("INSERT INTO events (id,project_id,json) VALUES (?,?,?)")
            .run(event.id, id, JSON.stringify(event))
        if (project.status === "queued") this.db.query("INSERT OR IGNORE INTO jobs (project_id) VALUES (?)").run(id)
        else this.db.query("DELETE FROM jobs WHERE project_id=?").run(id)
        if (project.status !== previous.status && ["failed", "cancelled", "interrupted"].includes(project.status)) {
          const row = this.db
            .query<ActivityRow, [string]>("SELECT token,json FROM activity_runs WHERE project_id=?")
            .get(id)
          const now = Date.now()
          const current = row
            ? MaterialActivity.parse(JSON.parse(row.json))
            : {
                stage:
                  project.stages.find((stage) => stage.status === "interrupted" || stage.status === "failed")?.key ??
                  ("intake" as const),
                startedAt: now,
              }
          this.writeActivity(id, null, { ...current, phase: project.status as ActivityEnd, updatedAt: now }, true)
        }
        return project
      })
      .immediate()
    this.onChange?.(structuredClone(result))
    return result
  }

  queued() {
    return this.db
      .query<{ project_id: string }, []>("SELECT project_id FROM jobs ORDER BY seq")
      .all()
      .map((row) => row.project_id)
  }

  /** A live local owner cannot be stolen, even if its event loop misses a heartbeat. */
  acquire(): boolean {
    return this.db
      .transaction(() => {
        const lease = this.db.query<Lease, []>("SELECT owner,pid,host,expires FROM scheduler WHERE id=1").get()
        if (lease?.owner === this.owner) {
          this.db.query("UPDATE scheduler SET expires=? WHERE id=1 AND owner=?").run(Date.now() + 30_000, this.owner)
          return true
        }
        if (lease && this.alive(lease)) return false
        if (lease) this.interrupt("服务器执行被中断，请确认后恢复任务")
        this.db
          .query("INSERT OR REPLACE INTO scheduler (id,owner,pid,host,expires) VALUES (1,?,?,?,?)")
          .run(this.owner, process.pid, os.hostname(), Date.now() + 30_000)
        return true
      })
      .immediate()
  }

  owns() {
    return this.db.query<{ owner: string }, []>("SELECT owner FROM scheduler WHERE id=1").get()?.owner === this.owner
  }

  interrupt(message: string) {
    for (const project of this.list()) {
      if (project.status !== "running" && project.status !== "queued") continue
      this.update(project.id, project.revision, (next) => {
        next.status = "interrupted"
        for (const stage of next.stages) if (stage.status === "running") stage.status = "interrupted"
        materialEvent(next, message, "error")
      })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.owns()) {
      this.interrupt("执行服务已停止，请确认后恢复任务")
      this.db.query("DELETE FROM scheduler WHERE owner=?").run(this.owner)
    }
    this.db.close()
  }

  private alive(lease: Lease) {
    if (lease.host !== os.hostname()) return lease.expires > Date.now()
    try {
      process.kill(lease.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH"
    }
  }
}
