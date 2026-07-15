// Incremental growth — pure merge of a freshly-fetched subgraph into the live
// graph WITHOUT relayout of what's already on screen.
//
// The anti-relayout guarantee: d3-force stores a node's simulation state
// (x/y/vx/vy) DIRECTLY on the node object. So the way to keep an existing node
// exactly where it settled is to keep the SAME object reference — never replace
// it with a fresh copy (a copy has no x/y → d3 re-seeds it at the origin → the
// whole layout "big-bangs"/re-explodes, the failure mode we're avoiding). Each
// genuinely-new node is seeded near a linked existing "anchor" so it spawns
// beside its connection and the sim only has to relax a small local patch.
//
// No DOM/React — unit-testable.

import type { FNode, FLink } from './buildForceData'

/** Max +/- offset (graph units) a new node is seeded from its anchor. Small so
 * the newcomer lands inside the anchor's spring neighborhood; the sim then
 * relaxes it out to link distance. Exported for the test's bound assertion. */
export const ANCHOR_JITTER = 12

export type MergeResult = {
  nodes: FNode[]
  links: FLink[]
  addedNodeIds: string[]
  anchorId: string | null
}

// A link endpoint is a string id before the sim runs and a node object after
// d3-force resolves it in place — normalize to the id either way.
function endpointId(end: unknown): string {
  return typeof end === 'object' && end !== null ? String((end as { id: unknown }).id) : String(end)
}

// Deterministic per-id hash (FNV-1a) → stable jitter, so growth placement is
// reproducible (no Math.random) and visual/test regressions are repeatable.
function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function graphCentroid(nodes: FNode[]): { x: number; y: number } {
  let sx = 0
  let sy = 0
  let n = 0
  for (const node of nodes) {
    if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
      sx += node.x as number
      sy += node.y as number
      n += 1
    }
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 }
}

// Anchor = an EXISTING endpoint of one of the new node's links.
function findAnchor(
  newId: string,
  links: FLink[],
  existingIds: Set<string>,
  byId: Map<string, FNode>,
): FNode | null {
  for (const l of links) {
    const s = endpointId(l.source)
    const t = endpointId(l.target)
    if (s === newId && existingIds.has(t)) return byId.get(t) ?? null
    if (t === newId && existingIds.has(s)) return byId.get(s) ?? null
  }
  return null
}

export function mergeSubgraph(
  existing: { nodes: FNode[]; links: FLink[] },
  incoming: { nodes: FNode[]; links: FLink[] },
): MergeResult {
  // Index existing by id → these live objects are REUSED (identity preserved).
  const byId = new Map<string, FNode>()
  for (const n of existing.nodes) byId.set(n.id, n)
  const existingIds = new Set(byId.keys())

  const nodes: FNode[] = [...existing.nodes] // keep existing OBJECTS in place
  const addedNodeIds: string[] = []
  const newNodes: FNode[] = []

  for (const inc of incoming.nodes) {
    if (byId.has(inc.id)) continue // already present → keep the live object; do NOT overwrite x/y
    // Genuinely new: shallow-clone the caller's object (fresh neighbors Set so we
    // never share mutable state with the caller). x/y are seeded below.
    const node: FNode = { ...inc, neighbors: new Set(inc.neighbors ?? []) }
    byId.set(node.id, node)
    nodes.push(node)
    newNodes.push(node)
    addedNodeIds.push(node.id)
  }

  // Merge links, deduped by source|target|relClass (normalized to ids). Existing
  // link objects are kept as-is (their post-sim object endpoints don't matter for
  // rendering); only genuinely-new links are appended.
  const linkKey = (s: string, t: string, rc: string) => `${s}|${t}|${rc}`
  const seen = new Set<string>()
  const links: FLink[] = [...existing.links]
  for (const l of existing.links) seen.add(linkKey(endpointId(l.source), endpointId(l.target), l.relClass))
  for (const l of incoming.links) {
    const s = endpointId(l.source)
    const t = endpointId(l.target)
    const key = linkKey(s, t, l.relClass)
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ source: s, target: t, relClass: l.relClass })
  }

  // Recompute degree + neighbors across the MERGED link set so hover/LOD math
  // stays correct after growth. This mutates the (reused) node objects' degree /
  // neighbors ONLY — never x/y/vx/vy — so existing-node identity + position hold.
  for (const n of nodes) {
    n.degree = 0
    n.neighbors = new Set<string>()
  }
  for (const l of links) {
    const s = endpointId(l.source)
    const t = endpointId(l.target)
    const sn = byId.get(s)
    const tn = byId.get(t)
    if (sn) {
      sn.degree += 1
      sn.neighbors.add(t)
    }
    if (tn) {
      tn.degree += 1
      tn.neighbors.add(s)
    }
  }

  // Seed each new node near its anchor (or the centroid if it has no existing
  // neighbor) so it spawns beside its connection instead of at the origin.
  const centroid = graphCentroid(existing.nodes)
  let anchorId: string | null = null
  for (const node of newNodes) {
    const anchor = findAnchor(node.id, links, existingIds, byId)
    const base = anchor ?? centroid
    const bx = Number.isFinite(base.x) ? (base.x as number) : 0
    const by = Number.isFinite(base.y) ? (base.y as number) : 0
    const h = hashId(node.id)
    node.x = bx + ((h & 0xffff) / 0xffff - 0.5) * 2 * ANCHOR_JITTER
    node.y = by + (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 2 * ANCHOR_JITTER
    if (!anchorId && anchor) anchorId = anchor.id
  }

  return { nodes, links, addedNodeIds, anchorId }
}
