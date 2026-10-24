import { projectName, type ProjectRecord } from "@/pages/home-projects"

function routeName(project: { worktree: string }, fallback: string) {
  const parts = project.worktree.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? fallback
}

/** The project the palette is searching, as the person knows it. A project
 * created in the app lives in a folder named by its id, so its folder is only
 * the label for a project the catalog does not hold (one opened from the CLI). */
export function scopeLabel(
  active: { projectID: string; project: { worktree: string } } | undefined,
  catalog: readonly ProjectRecord[],
  labels = { all: "All projects", current: "Current project" },
) {
  if (!active) return labels.all
  const record = catalog.find((item) => item.id === active.projectID)
  return record ? projectName(record) : routeName(active.project, labels.current)
}
