import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, resolver, validator, type DescribeRouteOptions } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import {
  MaterialBatchInput,
  MaterialActivitySnapshot,
  MaterialCreate,
  MaterialDecision,
  MaterialLibrarySnapshot,
  MaterialProject,
  MaterialSkillConfig,
  MaterialSkillSnapshot,
  MaterialSourceInput,
} from "@synsci/util/materials"
import { MaterialError, materialID } from "../../materials/store"
import { materialUploads } from "../../materials/uploads"
import { materialsService, type MaterialsService } from "../../materials/workflow"
import { materialSkillSettings, type MaterialSkillSettings } from "../../materials/skill-config"

const ErrorResponse = z.object({ error: z.string() })
const params = z.object({ id: z.string().regex(/^mat_[a-f0-9]{32}$/) })
const failures = Object.fromEntries(
  [400, 404, 409, 413, 422, 503].map((status) => [
    status,
    {
      description: "The request cannot be applied to the current research project",
      content: { "application/json": { schema: resolver(ErrorResponse) } },
    },
  ]),
)

function invalid(result: { success: boolean }, c: Context) {
  if (!result.success) return c.json({ error: "请求格式不正确，请检查必填内容" }, 400)
}

function describe(
  operationId: string,
  summary: string,
  schema: z.ZodType = MaterialProject,
  extra: Partial<DescribeRouteOptions> = {},
) {
  return describeRoute({
    operationId,
    summary,
    responses: {
      200: { description: "Research project", content: { "application/json": { schema: resolver(schema) } } },
      ...failures,
    },
    ...extra,
  })
}

async function protect(c: Context, handler: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await handler()
  } catch (error) {
    if (error instanceof MaterialError) return c.json({ error: error.message }, error.status)
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: "请求格式不正确",
          issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
        400,
      )
    if (error instanceof HTTPException) return c.json({ error: "请求格式不正确" }, error.status)
    return c.json({ error: "科研工作台暂时无法处理请求" }, 503)
  }
}

export function createMaterialsRoutes(
  injected?: MaterialsService,
  skills: MaterialSkillSettings = materialSkillSettings,
) {
  const service = () => (injected ? Promise.resolve(injected) : materialsService())
  return new Hono()
    .use("*", async (c, next) => {
      const upload = c.req.path.endsWith("/sources/upload")
      return bodyLimit({
        maxSize: (upload ? 23 : 3) * 1024 * 1024,
        onError: (c) => c.json({ error: upload ? "上传请求超过 23 MB" : "请求超过 3 MB，请分批上传" }, 413),
      })(c, next)
    })
    .use("*", async (c, next) => {
      if (
        c.req.method === "POST" &&
        !c.req.path.endsWith("/sources/upload") &&
        !(await c.req.json().then(
          () => true,
          () => false,
        ))
      )
        return c.json({ error: "请求格式不正确" }, 400)
      return next()
    })
    .get(
      "/skills",
      describe("materials.getSkills", "Get per-stage skills and retrieval availability", MaterialSkillSnapshot),
      async (c) =>
        protect(c, async () => {
          c.header("Cache-Control", "no-store")
          return c.json(await skills.get())
        }),
    )
    .post(
      "/skills",
      describe(
        "materials.saveSkills",
        "Configure skills for future stage starts without running research",
        MaterialSkillSnapshot,
      ),
      validator("json", MaterialSkillConfig, invalid),
      async (c) =>
        protect(c, async () => {
          c.header("Cache-Control", "no-store")
          return c.json(await skills.save(c.req.valid("json")))
        }),
    )
    .get(
      "/projects",
      describeRoute({
        operationId: "materials.list",
        summary: "List materials research projects",
        responses: {
          200: {
            description: "Projects",
            content: { "application/json": { schema: resolver(MaterialProject.array()) } },
          },
          ...failures,
        },
      }),
      async (c) => protect(c, async () => c.json((await service()).list())),
    )
    .post(
      "/projects",
      describe("materials.create", "Create and start a materials research project"),
      validator("json", MaterialCreate, invalid),
      async (c) => protect(c, async () => c.json((await service()).create(c.req.valid("json")))),
    )
    .get(
      "/projects/:id/library",
      describe(
        "materials.library",
        "Get project files, saved results, and synchronization status",
        MaterialLibrarySnapshot,
      ),
      validator("param", params, invalid),
      async (c) =>
        protect(c, async () => {
          c.header("Cache-Control", "no-store")
          return c.json(await (await service()).library(c.req.valid("param").id))
        }),
    )
    .post(
      "/projects/:id/library",
      describe(
        "materials.syncLibrary",
        "Sync existing research to project files and Results without running models",
        MaterialLibrarySnapshot,
      ),
      validator("param", params, invalid),
      validator("json", z.object({}).strict(), invalid),
      async (c) => protect(c, async () => c.json(await (await service()).syncLibrary(c.req.valid("param").id))),
    )
    .get(
      "/projects/:id/activity",
      describe(
        "materials.activity",
        "Get lightweight live activity and recent research milestones",
        MaterialActivitySnapshot,
      ),
      validator("param", params, invalid),
      async (c) =>
        protect(c, async () => {
          c.header("Cache-Control", "no-store")
          return c.json((await service()).activity(c.req.valid("param").id))
        }),
    )
    .get(
      "/projects/:id",
      describe("materials.get", "Get a materials research project and its progress"),
      validator("param", params, invalid),
      async (c) => protect(c, async () => c.json((await service()).get(c.req.valid("param").id))),
    )
    .post(
      "/projects/:id/actions",
      describe("materials.decide", "Resume, cancel, or approve a research workflow"),
      validator("param", params, invalid),
      validator("json", MaterialDecision, invalid),
      async (c) =>
        protect(c, async () => c.json((await service()).decide(c.req.valid("param").id, c.req.valid("json")))),
    )
    .post(
      "/projects/:id/sources/upload",
      describe("materials.uploadSource", "Attach a paper and retain its original PDF or text file", MaterialProject, {
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file", "source"],
                properties: {
                  file: { type: "string", format: "binary", description: "Original PDF, TXT or Markdown, up to 20 MB" },
                  source: {
                    type: "string",
                    description: "JSON-encoded MaterialSourceInput with extracted text and citation metadata",
                  },
                },
              },
            },
          },
        },
      }),
      validator("param", params, invalid),
      async (c) =>
        protect(c, async () => {
          if (!c.req.header("Content-Type")?.startsWith("multipart/form-data"))
            throw new MaterialError(400, "请使用文件上传表单")
          const data = await c.req.formData().catch(() => undefined)
          const file = data?.get("file")
          const source = data?.get("source")
          if (!(file instanceof File) || typeof source !== "string")
            throw new MaterialError(400, "请同时提交原始文件与文献信息")
          if (source.length > 1_500_000) throw new MaterialError(413, "文献信息过大")
          const parsed = MaterialSourceInput.parse(
            await Promise.resolve()
              .then(() => JSON.parse(source))
              .catch(() => undefined),
          )
          const current = await service()
          const id = c.req.valid("param").id
          current.get(id)
          const sourceID = materialID("src")
          const uploads = materialUploads(current.store.directory)
          await uploads.save(id, sourceID, file)
          try {
            return c.json(current.source(id, parsed, { id: sourceID }))
          } catch (error) {
            await uploads.remove(id, sourceID)
            throw error
          }
        }),
    )
    .post(
      "/projects/:id/sources",
      describe("materials.source", "Attach a text source to a research project"),
      validator("param", params, invalid),
      validator("json", MaterialSourceInput, invalid),
      async (c) =>
        protect(c, async () => c.json((await service()).source(c.req.valid("param").id, c.req.valid("json")))),
    )
    .post(
      "/projects/:id/batches",
      describe("materials.batch", "Record measurements against an approved protocol version"),
      validator("param", params, invalid),
      validator("json", MaterialBatchInput, invalid),
      async (c) =>
        protect(c, async () => c.json((await service()).batch(c.req.valid("param").id, c.req.valid("json")))),
    )
    .get(
      "/projects/:id/export",
      describe("materials.export", "Export a complete research project with immutable artifacts"),
      validator("param", params, invalid),
      async (c) =>
        protect(c, async () => {
          const project = (await service()).get(c.req.valid("param").id)
          c.header("Content-Disposition", `attachment; filename="${project.id}.json"`)
          c.header("Cache-Control", "no-store")
          return c.json(project)
        }),
    )
}

export const MaterialsRoutes = lazy(() => createMaterialsRoutes())
