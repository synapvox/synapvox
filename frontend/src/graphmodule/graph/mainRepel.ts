// mainRepel — a custom d3-force that pushes the project "main" hubs far apart so
// each topic cluster gets its own region of the canvas (galaxy view). No-op with
// <2 hubs.
//
// Crucially it SKIPS any hub the user is holding or has placed (fx set): a pinned
// hub must neither be pushed nor push its neighbours. Without this, dragging one
// hub toward another can't move the pinned (dragged) hub, so the force shoves the
// OTHER hub away instead — the "머신러닝이 반대로 도망가는" bug. Extracted from
// GraphView so the interaction rule is unit-testable.
import type { FNode } from './buildForceData'

export type SimNode = FNode & {
  vx?: number
  vy?: number
  fx?: number | null // set by force-graph while dragging; kept by us to pin hubs
  fy?: number | null
}

export const MAIN_SEPARATION = 1300

export function makeMainRepel() {
  let nodes: SimNode[] = []
  const force = (alpha: number) => {
    const mains = nodes.filter((n) => n.type === 'main')
    for (let i = 0; i < mains.length; i++) {
      for (let j = i + 1; j < mains.length; j++) {
        const a = mains[i]
        const b = mains[j]
        // Held or placed hub → leave the pair alone (see file header).
        if (a.fx != null || b.fx != null) continue
        const dx = (b.x ?? 0) - (a.x ?? 0)
        const dy = (b.y ?? 0) - (a.y ?? 0)
        const d = Math.hypot(dx, dy) || 0.01
        if (d < MAIN_SEPARATION) {
          const push = ((MAIN_SEPARATION - d) / d) * alpha * 0.5
          a.vx = (a.vx ?? 0) - dx * push
          a.vy = (a.vy ?? 0) - dy * push
          b.vx = (b.vx ?? 0) + dx * push
          b.vy = (b.vy ?? 0) + dy * push
        }
      }
    }
  }
  ;(force as unknown as { initialize: (n: SimNode[]) => void }).initialize = (n) => {
    nodes = n
  }
  return force
}
