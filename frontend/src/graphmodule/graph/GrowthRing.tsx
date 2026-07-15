// GrowthRing — the signature flourish when a session is added. A canvas ripple
// emanates from the new session node over ~900ms, its stroke crossfading from
// --session-red (the session's own color) to --node-core (the lime concept
// core), rippling outward over the linked concepts. It is a PURELY VISUAL
// overlay: pointer-events:none and it never touches the simulation, so it cannot
// move the graph. Honors prefers-reduced-motion with a tiny ≤150ms opacity/scale
// fallback instead of the full expanding ripple.

import { useEffect, useRef } from 'react'

/** A fire signal. Bump `id` to (re)start the ripple on `nodeId`. */
export type GrowthPulse = { id: number; nodeId: string }

type Props = {
  pulse: GrowthPulse | null
  width: number
  height: number
  /** live screen-space position of a node id (null if not resolvable yet) */
  getScreenPos: (nodeId: string) => { x: number; y: number } | null
  onDone?: () => void
}

const DURATION_MS = 900
const REDUCED_MS = 150

// Exact palette (spec §3). Canvas can't read CSS vars → literal channels.
const SESSION_RED = { r: 0xc8, g: 0x4e, b: 0x3a } // #C84E3A
const NODE_CORE = { r: 0xd8, g: 0xff, b: 0x6a } // #D8FF6A

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

function mix(c1: typeof SESSION_RED, c2: typeof NODE_CORE, t: number) {
  return {
    r: Math.round(lerp(c1.r, c2.r, t)),
    g: Math.round(lerp(c1.g, c2.g, t)),
    b: Math.round(lerp(c1.b, c2.b, t)),
  }
}

function drawRipple(
  ctx: CanvasRenderingContext2D,
  origin: { x: number; y: number },
  t: number,
  reduced: boolean,
) {
  const startR = 6
  const maxR = reduced ? 22 : 92
  // Full motion emanates two staggered rings; reduced motion draws one that just
  // fades (near-static radius) so it reads as a soft pulse, not a sweep.
  const rings = reduced ? 1 : 2
  for (let i = 0; i < rings; i++) {
    const lag = i * 0.28
    if (t <= lag) continue
    const tt = Math.min(1, (t - lag) / (1 - lag))
    const e = easeOutCubic(tt)
    const radius = startR + (maxR - startR) * e
    const alpha = (1 - tt) * 0.9
    if (alpha <= 0.01) continue
    const col = mix(SESSION_RED, NODE_CORE, tt)
    ctx.beginPath()
    ctx.arc(origin.x, origin.y, radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`
    ctx.lineWidth = reduced ? 2 : 1 + (1 - tt) * 2.5
    ctx.stroke()
  }
}

export function GrowthRing({ pulse, width, height, getScreenPos, onDone }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Keep the latest callbacks in refs so a re-render mid-animation (e.g. hover
  // tick) doesn't restart or tear down the running ripple.
  const getPosRef = useRef(getScreenPos)
  const onDoneRef = useRef(onDone)
  getPosRef.current = getScreenPos
  onDoneRef.current = onDone

  const pulseId = pulse?.id ?? -1
  const nodeId = pulse?.nodeId ?? null

  useEffect(() => {
    if (!pulse) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const duration = reduced ? REDUCED_MS : DURATION_MS
    const start = performance.now()
    let raf = 0

    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const origin = getPosRef.current(pulse.nodeId)
      if (origin) drawRipple(ctx, origin, t, reduced)
      if (t < 1) {
        raf = requestAnimationFrame(frame)
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        onDoneRef.current?.()
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    // Restart only when a NEW pulse fires (id/node change) — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseId, nodeId])

  return (
    <canvas
      ref={canvasRef}
      width={Math.max(0, Math.round(width))}
      height={Math.max(0, Math.round(height))}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 4,
      }}
    />
  )
}

export default GrowthRing
