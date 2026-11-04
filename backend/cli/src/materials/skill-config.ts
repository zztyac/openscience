import path from "node:path"
import fs from "node:fs/promises"
import { MaterialSkillConfig, MaterialSkillName, MaterialSkillSnapshot, materialStages } from "@synsci/util/materials"
import { Global } from "@/global"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { FileLease } from "@/util/file-lease"
import { Lock } from "@/util/lock"
import { MaterialError } from "./store"
import { skillAvailability } from "./skill-sources"

const descriptions: Record<MaterialSkillName, string> = {
  arxiv: "Search arXiv preprints and retrieve open PDF versions.",
  deepxiv: "Search preprints and paper metadata through DeepXiv to locate originals and evidence.",
  "exa-search": "Find scholarly pages and open paper copies through Exa.",
  openalex: "Search scholarly metadata, abstracts and open-access locations.",
  "research-lit": "Coordinate literature discovery across public scholarly sources.",
  "semantic-scholar": "Search papers, citation metadata and open-access PDF locations.",
}

export function defaultMaterialSkills(): MaterialSkillConfig {
  return {
    revision: 0,
    stages: {
      intake: [],
      literature: ["arxiv", "openalex", "semantic-scholar", "research-lit"],
      strategies: [],
      ideas: [],
      protocol: [],
      analysis: [],
    },
  }
}

export function createMaterialSkillSettings(
  options: {
    directory?: string
    availability?: (
      name: MaterialSkillName,
    ) => { available: boolean; reason?: string } | Promise<{ available: boolean; reason?: string }>
  } = {},
) {
  const file = path.join(options.directory ?? path.join(Global.Path.data, "materials"), "skills.json")
  const availability = options.availability ?? skillAvailability
  const read = async (): Promise<MaterialSkillConfig> => {
    const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (text === undefined) return defaultMaterialSkills()
    try {
      return MaterialSkillConfig.parse(JSON.parse(text))
    } catch {
      throw new MaterialError(503, "材料阶段 Skill 配置无法读取，请修复配置文件后重试；原文件已保留。")
    }
  }
  const snapshot = async (config: MaterialSkillConfig): Promise<MaterialSkillSnapshot> =>
    MaterialSkillSnapshot.parse({
      ...config,
      catalog: await Promise.all(
        MaterialSkillName.options.map(async (name) => ({
          name,
          description: descriptions[name],
          ...(await availability(name)),
        })),
      ),
    })
  return {
    read,
    async get() {
      return snapshot(await read())
    },
    async save(input: MaterialSkillConfig) {
      const parsed = MaterialSkillConfig.parse(input)
      // The on-disk lease covers independent server/CLI processes as well as HTTP requests.
      return DataRootBarrier.during(file, async () => {
        using lock = await Lock.write(file)
        await using lease = await FileLease.acquire(`${file}.lock`)
        return await lease.during(async () => {
          const current = await read()
          if (parsed.revision !== current.revision)
            throw new MaterialError(409, "阶段 Skill 配置已更新，请重新加载后再保存。")
          const next = MaterialSkillConfig.parse({
            revision: current.revision + 1,
            stages: Object.fromEntries(materialStages.map((stage) => [stage, [...new Set(parsed.stages[stage])]])),
          })
          const result = await snapshot(next)
          const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
          try {
            const handle = await fs.open(temporary, "wx", 0o600)
            await handle
              .writeFile(JSON.stringify(next, null, 2), "utf8")
              .then(() => handle.sync())
              .finally(() => handle.close())
            await fs.rename(temporary, file)
            const directory = await fs.open(path.dirname(file), "r").catch(() => undefined)
            await directory?.sync().catch(() => undefined)
            await directory?.close().catch(() => undefined)
          } finally {
            await fs.rm(temporary, { force: true }).catch(() => undefined)
          }
          return result
        })
      })
    },
  }
}

export type MaterialSkillSettings = ReturnType<typeof createMaterialSkillSettings>
export const materialSkillSettings = createMaterialSkillSettings()
