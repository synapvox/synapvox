// Pure transform: mapGraph output -> react-force-graph-2d ready {nodes,links}.
// Precomputes `degree` (incident-link count) and `neighbors` (adjacent ids,
// both directions) per node so hover highlight is O(1) at draw time.
// No DOM/React — unit-testable.

import type { GraphNode, GraphLink, RelClass } from './mapGraph'

export type FNode = {
  id: string
  type: 'session' | 'concept' | 'main' // 'main' = the single synthetic project hub
  label: string
  seq?: number
  bridge: boolean
  degree: number
  neighbors: Set<string>
  project?: string // which project this node came from (set when galaxy-merging)
  x?: number
  y?: number
}

export type FRelClass = RelClass

export type FLink = {
  source: string
  target: string
  relClass: FRelClass
}

export function buildForceData(mapped: {
  nodes: GraphNode[]
  links: GraphLink[]
}): { nodes: FNode[]; links: FLink[] } {
  // Copy each GraphNode into an FNode with fresh (per-call) degree/neighbors
  // state, dropping render-only fields (r) not consumed by the force graph.
  const nodes: FNode[] = mapped.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.label,
    seq: n.seq,
    bridge: n.bridge,
    degree: 0,
    neighbors: new Set<string>(),
  }))

  const byId = new Map<string, FNode>()
  for (const n of nodes) byId.set(n.id, n)

  const links: FLink[] = mapped.links.map((l) => {
    const from = byId.get(l.from)
    const to = byId.get(l.to)
    // Count degree + register neighbors in both directions. Guard against a
    // link that references an id absent from `nodes` (dangling endpoint).
    if (from) {
      from.degree += 1
      from.neighbors.add(l.to)
    }
    if (to) {
      to.degree += 1
      to.neighbors.add(l.from)
    }
    return { source: l.from, target: l.to, relClass: l.relClass }
  })

  return { nodes, links }
}
