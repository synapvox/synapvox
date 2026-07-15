// Cross-connections: when two or more projects are visualized together, a
// concept that appears in BOTH (e.g. 경사하강법 in 딥러닝 and 머신러닝) is the
// "연결점" between the topics. Each project's graph is independent (distinct node
// ids per Graphiti group), so we match concepts by *normalized label* and link
// the matching nodes across projects with a synthetic 'cross' edge.
//
// Pure + unit-tested — no DOM/canvas. GraphView appends the result to its links.
import type { FLink } from './buildForceData'

/** Normalize a concept label for exact cross-project matching: trim, collapse
 * internal whitespace, lowercase. Deliberately conservative (exact match after
 * light normalization) — decided in the IA spec, not fuzzy/semantic. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

type CrossNode = { id: string; type: 'session' | 'concept' | 'main'; label: string; project?: string }

/** Build cross-project bridge links between concept nodes that share a normalized
 * label across ≥2 distinct projects. Returns the links plus the set of node ids
 * that participate (so the renderer can mark them). Only 'concept' nodes bridge;
 * sessions/hubs never do. Pairs are unordered and only cross-project. */
export function computeCrossLinks(nodes: CrossNode[]): { links: FLink[]; crossIds: Set<string> } {
  const groups = new Map<string, { id: string; project: string }[]>()
  for (const n of nodes) {
    if (n.type !== 'concept') continue
    const key = normalizeLabel(n.label)
    if (!key) continue
    const bucket = groups.get(key)
    const entry = { id: n.id, project: n.project ?? '' }
    if (bucket) bucket.push(entry)
    else groups.set(key, [entry])
  }

  const links: FLink[] = []
  const crossIds = new Set<string>()
  for (const members of groups.values()) {
    // Needs the same label in at least two DIFFERENT projects to be a bridge.
    const projects = new Set(members.map((m) => m.project))
    if (projects.size < 2) continue
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (members[i].project === members[j].project) continue
        links.push({ source: members[i].id, target: members[j].id, relClass: 'cross' })
        crossIds.add(members[i].id)
        crossIds.add(members[j].id)
      }
    }
  }
  return { links, crossIds }
}
