// Pure draw helpers for the force graph — node sizing, node core colors, and
// link colors. No DOM/canvas/React here so they stay unit-testable; the actual
// canvas painting lives in GraphView.tsx and calls these.
//
// Palette mirrors the main SynapVox notebook UI: warm paper, moss accents,
// and quiet wood lines instead of the original high-contrast studio colors.

import type { FRelClass } from './buildForceData'

const CONCEPT_BASE = 4.2
const SESSION_BASE = 5.8 // sessions read slightly heavier than concepts
const DEGREE_SCALE = 1.15

/** Node radius in graph units. `base + sqrt(degree) * scale` keeps hubs visibly
 * bigger, then a tier-specific cap prevents one node from dwarfing the graph. */
export function nodeRadius(degree: number, type: 'session' | 'concept' | 'main'): number {
  if (type === 'main') return 14 // clear hierarchy without overpowering the graph
  const base = type === 'session' ? SESSION_BASE : CONCEPT_BASE
  const d = Number.isFinite(degree) && degree > 0 ? degree : 0
  const cap = type === 'session' ? 10.5 : 9
  return Math.min(base + Math.sqrt(d) * DEGREE_SCALE, cap)
}

// Hierarchy tiers by color:
//   main (project hub)     → dark ink
//   session (recording)    → warm wood
//   bridge concept (핵심)  → moss
//   leaf concept (일반)    → quiet stone
const C_MAIN = '#342E26'
const C_SESSION = '#987653'
const C_CONCEPT_BRIDGE = '#66715B'
const C_CONCEPT_LEAF = '#A89B84'

/** Core/stroke color for a node. `bridge` splits load-bearing concepts from
 * leaf concepts; size still encodes degree. */
export function nodeCoreColor(type: 'session' | 'concept' | 'main', bridge: boolean): string {
  if (type === 'main') return C_MAIN
  if (type === 'session') return C_SESSION
  return bridge ? C_CONCEPT_BRIDGE : C_CONCEPT_LEAF
}

// Dense relationship edges stay quiet by default. Hover and AI evidence focus
// replace their alpha in GraphView, so the relevant path becomes crisp on demand.
const RULE_WOOD = 'rgba(165, 147, 120, 0.34)'
const RULE_MOSS = 'rgba(102, 113, 91, 0.48)'
const RULE_STRONG = '#7E7867'
const MENTIONS_DIM = 'rgba(126, 120, 103, 0.18)'
/** Link stroke color by relation class. */
export function linkColor(relClass: FRelClass): string {
  switch (relClass) {
    case 'mentions':
      return MENTIONS_DIM
    case 'next':
    case 'continues':
      return RULE_STRONG
    case 'cooccur':
      return RULE_WOOD
    case 'expands':
      return RULE_MOSS
    default:
      return RULE_WOOD
  }
}
