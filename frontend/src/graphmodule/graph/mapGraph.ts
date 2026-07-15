// Pure transform: backend /graph payload -> render-ready nodes/links.
// No DOM/React — unit-testable. Degree drives concept radius; "bridge" =
// a concept mentioned by >=2 distinct sessions (a cross-session connector).

import type { GraphData } from '../api/types'

export type RelClass = 'mentions' | 'cooccur' | 'next' | 'continues' | 'expands'

export type GraphNode = {
  id: string
  type: 'session' | 'concept'
  label: string
  r: number
  seq?: number
  bridge: boolean
}

export type GraphLink = {
  from: string
  to: string
  rel: string
  relClass: RelClass
}

const REL_CLASS: Record<string, RelClass> = {
  SESSION_MENTIONS_CONCEPT: 'mentions',
  CONCEPT_RELATES_TO: 'expands',
  CONCEPT_CO_OCCURS_WITH: 'cooccur',
  NEXT_SESSION: 'next',
  CONTINUES: 'continues',
  EXPANDS: 'expands',
}

export function mapGraph(raw: GraphData): { nodes: GraphNode[]; links: GraphLink[] } {
  // Resolve node types up front so mention direction is robust regardless of
  // which endpoint the backend puts src/dst on.
  const typeOf: Record<string, 'session' | 'concept'> = {}
  for (const n of raw.nodes) {
    typeOf[n.id] = n.type === 'session' ? 'session' : 'concept'
  }

  // Build the render-ready `links` FIRST, dropping edges with an unknown
  // rel_type. Degree/bridge must be derived from this filtered list —
  // otherwise a dropped edge would still inflate the degree (and therefore
  // the radius `r`) of a concept that never actually gets rendered.
  const links: GraphLink[] = []
  for (const e of raw.edges) {
    const relClass = REL_CLASS[e.rel_type]
    if (!relClass) continue // drop unknown relation types
    links.push({ from: e.src, to: e.dst, rel: e.rel_type, relClass })
  }

  const degree: Record<string, number> = {}
  const mentioners: Record<string, Set<string>> = {} // concept id -> distinct session ids

  for (const l of links) {
    degree[l.from] = (degree[l.from] ?? 0) + 1
    degree[l.to] = (degree[l.to] ?? 0) + 1
    if (l.rel === 'SESSION_MENTIONS_CONCEPT') {
      const srcIsSession = typeOf[l.from] === 'session'
      const dstIsSession = typeOf[l.to] === 'session'
      // Only attribute a mention when exactly one endpoint is a session —
      // a malformed edge where neither (or both) endpoint is a session
      // must not be misattributed to either side.
      if (srcIsSession !== dstIsSession) {
        const sessionEnd = srcIsSession ? l.from : l.to
        const conceptEnd = srcIsSession ? l.to : l.from
        ;(mentioners[conceptEnd] ??= new Set()).add(sessionEnd)
      }
    }
  }

  const nodes: GraphNode[] = raw.nodes.map((n) => {
    const type: 'session' | 'concept' = n.type === 'session' ? 'session' : 'concept'
    const deg = degree[n.id] ?? 0
    const bridge = type === 'concept' && (mentioners[n.id]?.size ?? 0) >= 2
    // session r is unused by the renderer (drawn as a rect); give it a stable value.
    const r = type === 'concept' ? Math.min(7 + deg * 0.7, 16) : 10
    const seqRaw = n.meta?.seq
    const seq = typeof seqRaw === 'number' ? seqRaw : undefined
    return { id: n.id, type, label: n.label ?? n.id, r, seq, bridge }
  })

  return { nodes, links }
}
