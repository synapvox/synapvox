// Shared project display metadata. A project's group_id is an ASCII slug; the
// friendly name comes from two places, checked in order:
//   1. server-stored display names (e.g. "최적화개론") — populated from /projects
//      via rememberProjectNames(); visible on every device/teammate.
//   2. the seeded demo projects' hardcoded labels.
//   3. fallback = the id itself.
// Kept in its own tiny module so the sidebar/dashboard can import `projectLabel`
// without pulling in the heavy GraphView (react-force-graph-2d) component.
const PROJECT_LABELS: Record<string, string> = { 'P-BIO': '딥러닝', 'P-LIFE': '생명과학', 'P-ML': '머신러닝' }

// Server-provided names, cached module-wide so projectLabel(id) resolves the
// human name everywhere (sidebar, dashboard, graph hubs) — including callers that
// only hold the id. Populated whenever the projects list loads.
const NAME_CACHE: Record<string, string> = {}

/** Merge server-stored display names (from /projects) into the cache. */
export function rememberProjectNames(projects: { project: string; name?: string | null }[]): void {
  for (const p of projects) {
    if (p.name && p.name.trim()) NAME_CACHE[p.project] = p.name.trim()
  }
}

export function projectLabel(project: string): string {
  return NAME_CACHE[project] ?? PROJECT_LABELS[project] ?? project
}
