// Pure draw helpers for the force graph — node sizing, node core colors, and
// link colors. No DOM/canvas/React here so they stay unit-testable; the actual
// canvas painting lives in GraphView.tsx and calls these.
//
// Palette mirrors the main SynapVox notebook UI: warm paper, moss accents,
// and quiet wood lines instead of the original high-contrast studio colors.

import type { FRelClass } from './buildForceData'

const CONCEPT_BASE = 4
const SESSION_BASE = 5 // sessions read slightly heavier than concepts
const DEGREE_SCALE = 1.8

/** Node radius in graph units. `base + sqrt(degree) * scale` — sqrt keeps hubs
 * visibly bigger without letting a single super-hub dwarf everything (linear
 * would). Strictly monotonic increasing in degree. */
export function nodeRadius(degree: number, type: 'session' | 'concept' | 'main'): number {
  if (type === 'main') return 18 // the single project hub — always the biggest
  const base = type === 'session' ? SESSION_BASE : CONCEPT_BASE
  const d = Number.isFinite(degree) && degree > 0 ? degree : 0
  return base + Math.sqrt(d) * DEGREE_SCALE
}

// Hierarchy tiers by color (sub-nodes drawn HOLLOW → the color is the outline):
//   main (topic hub)       → paper ivory
//   session (lecture)      → vermilion
//   bridge concept (핵심)  → lime (spans ≥2 lectures — the load-bearing ideas)
//   leaf concept (일반)    → muted teal (a single lecture's concept, recedes)
const C_MAIN = '#322B22'
const C_SESSION = '#9A6E52'
const C_CONCEPT_BRIDGE = '#6D735D'
const C_CONCEPT_LEAF = '#B9A17B'

/** Core/stroke color for a node, by hierarchy tier. `bridge` splits concepts into
 * the load-bearing (lime) vs leaf (teal) tiers. Size still encodes degree (see
 * nodeRadius) — color and size together read the hierarchy. */
export function nodeCoreColor(type: 'session' | 'concept' | 'main', bridge: boolean): string {
  if (type === 'main') return C_MAIN
  if (type === 'session') return C_SESSION
  return bridge ? C_CONCEPT_BRIDGE : C_CONCEPT_LEAF
}

// rule-blue variants. Structural/cooccurrence edges use the flat base; the
// sequential NEXT/CONTINUES spine is slightly brighter (stronger); loose
// SESSION_MENTIONS_CONCEPT edges are translucent (dimmer) — and drawn dashed
// in GraphView via linkLineDash.
const RULE_BLUE = '#A99572'
const RULE_BLUE_STRONG = '#7A8069'
const MENTIONS_DIM = 'rgba(169, 149, 114, 0.34)'
// Cross-project "shared concept" bridge — brighter rule-blue so it reads across
// the gap between two topic clusters (drawn dashed in GraphView).
const CROSS_BLUE = '#6D735D'

/** Link stroke color by relation class. */
export function linkColor(relClass: FRelClass): string {
  switch (relClass) {
    case 'cross':
      return CROSS_BLUE
    case 'mentions':
      return MENTIONS_DIM
    case 'next':
    case 'continues':
      return RULE_BLUE_STRONG
    case 'cooccur':
    case 'expands':
    default:
      return RULE_BLUE
  }
}
