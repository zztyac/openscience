import type { useLanguage } from "@/context/language"
import type { ProjectRequest } from "@/utils/openscience-fetch"

export type ExecutionCapability =
  | "terminal"
  | "kernel"
  | "shell"
  | "local_job"
  | "remote_job"
  | "package_install"
  | "project_plugin"
  | "project_mcp"
  | "project_formatter"
  | "project_lsp"
  | "provider_token_command"

export interface ExecutionDecision {
  allowed: boolean
  reason: "allowed" | "project_untrusted" | "sandbox_unavailable"
  message?: string
  capability: ExecutionCapability
  mode: "read_only" | "sandboxed" | "host"
  projectID: string
  sessionID: string
  trustRevision: number
  grantRevision: number
  generation: string
  workspace: string
  writable: string[]
  sandbox: {
    enabled: boolean
    network: "allow" | "deny"
    allowWrite: string[]
    onUnavailable: "warn" | "error" | "allow"
    requireProjectTrust?: boolean
    backend: "seatbelt" | "bubblewrap" | "none"
    available: boolean
    enforced: boolean
  }
  remediation?: {
    code: "trust_project_required"
    message: string
    method: "PUT"
    path: string
    body: {
      trusted: true
      root: string
    }
  }
}

export interface ExecutionAuthorityInput {
  projectID: string
  sessionID: string
  capability: ExecutionCapability
}

const labels: Record<ExecutionCapability, string> = {
  terminal: "start a terminal",
  kernel: "start or restart a kernel",
  shell: "run a shell command",
  local_job: "dispatch a local job",
  remote_job: "dispatch a remote job",
  package_install: "install project packages",
  project_plugin: "start a project plugin",
  project_mcp: "start a project MCP server",
  project_formatter: "start a project formatter",
  project_lsp: "start a project language server",
  provider_token_command: "run a provider token command",
}

export function createExecutionAuthorityAPI(request: ProjectRequest) {
  return {
    async inspect(input: ExecutionAuthorityInput): Promise<ExecutionDecision> {
      const response = await request(`/project/${encodeURIComponent(input.projectID)}/execution`, undefined, {
        sessionID: input.sessionID,
        capability: input.capability,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(detail || `${response.status} ${response.statusText}`)
      }
      const content = response.headers.get("content-type") ?? ""
      if (!content.includes("application/json")) {
        throw new Error(
          `Expected JSON from execution authority, but got ${response.status} (${content || "no content-type"})`,
        )
      }
      return response.json() as Promise<ExecutionDecision>
    },
    async trust(input: ExecutionDecision): Promise<void> {
      const remediation = input.remediation
      const target = `/project/${encodeURIComponent(input.projectID)}/trust`
      if (
        input.allowed ||
        input.reason !== "project_untrusted" ||
        !remediation ||
        remediation.method !== "PUT" ||
        remediation.path !== target ||
        remediation.body.trusted !== true ||
        !remediation.body.root
      ) {
        throw new Error("The server did not provide a valid project-trust action.")
      }
      const response = await request(target, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remediation.body),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(detail || `${response.status} ${response.statusText}`)
      }
    },
  }
}

export function executionAuthorityMessage(
  decision: ExecutionDecision,
  translate?: ReturnType<typeof useLanguage>["t"],
): string | undefined {
  if (decision.allowed) return
  if (decision.message) return decision.message
  const keys = {
    shell: "pages.surface.capability.shell",
    terminal: "pages.surface.capability.terminal",
    kernel: "pages.surface.capability.kernel",
    local_job: "pages.surface.capability.local_job",
    remote_job: "pages.surface.capability.remote_job",
    package_install: "pages.surface.capability.package_install",
    project_plugin: "pages.surface.capability.project_plugin",
    project_mcp: "pages.surface.capability.project_mcp",
    project_formatter: "pages.surface.capability.project_formatter",
    project_lsp: "pages.surface.capability.project_lsp",
    provider_token_command: "pages.surface.capability.provider_token_command",
  } as const
  const label = translate ? translate(keys[decision.capability]) : labels[decision.capability]
  const action = label.charAt(0).toLocaleLowerCase() + label.slice(1)
  if (decision.reason === "project_untrusted")
    return translate?.("pages.surface.executionTrust", { action }) ?? `Trust this project to ${action} in this session.`
  return (
    translate?.("pages.surface.executionSandbox", { action }) ??
    `A verified OS sandbox is required to ${action}. OpenScience could not enforce one on this computer.`
  )
}

export function executionAuthorityError(error: unknown, translate?: ReturnType<typeof useLanguage>["t"]): string {
  const detail = error instanceof Error ? error.message : String(error)
  return translate?.("pages.surface.executionError", { detail }) ?? `Execution access could not be verified. ${detail}`
}
