// GraphView — the hero. react-force-graph-2d (canvas + d3-force) tuned for
// Obsidian-style *living elasticity*: a well-behaved spring system that settles
// calmly (~1.5–2s) yet stays alive on interaction — dragging a node pulls its
// neighbors like springs and releasing lets it re-settle. NOT a hard freeze.
//
// The old jank was bad spring constants + an unbounded render loop. The fix is
// GOOD d3-force tuning + a *bounded* cooldownTicks (stops the render loop only
// AFTER it has calmed, to save idle CPU) — never cooldownTicks=0, never a
// permanent fx/fy pin. Drag auto-reheats the simulation (library behavior);
// force-graph's default autoPauseRedraw pauses the idle redraw loop and revives
// it on pointer interaction, so "calm at rest" never means "dead frozen frame".

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject,
  type LinkObject,
} from 'react-force-graph-2d'
import { getGraph, ApiError } from '../api/client'
import { mapGraph } from './mapGraph'
import { buildForceData, type FNode, type FLink } from './buildForceData'
import { loadPositions, savePositions } from './positionCache'
import { nodeRadius, nodeCoreColor, linkColor } from './render'
import { labelOpacity } from './lod'
import { mergeSubgraph } from './growth'
import { GrowthRing, type GrowthPulse } from './GrowthRing'

const CANVAS_BG = '#FFFAF0' // literal hex — canvas ctx can't read a CSS var
const LABEL_INK = '#322B22'
const NODE_PAPER = '#FFFDF7'
const SESSION_FILL = '#F1E5D3'
const BRIDGE_FILL = '#E4E9DE'
// Canvas ctx can't resolve `var(--font-ui)`; use the literal Atkinson stack.
const LABEL_FONT = "'Atkinson Hyperlegible', system-ui, sans-serif"
const COLD_START_MS = 6000 // Render free tier can cold-start ~50s; reassure after this

// A link endpoint is a string id before the sim runs and a node object after
// d3-force resolves it in place — normalize to the id either way.
function endpointId(end: unknown): string {
  return typeof end === 'object' && end !== null ? String((end as { id: unknown }).id) : String(end)
}

// Re-color a token color (hex or rgba) to a target alpha for hover dimming.
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const m = color.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => parseFloat(s.trim()))
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `rgba(126, 120, 103, ${alpha})`
}

function compactLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

function roundedSquare(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  radius: number,
): void {
  const left = x - size / 2
  const top = y - size / 2
  const right = left + size
  const bottom = top + size
  const r = Math.min(radius, size / 2)
  ctx.beginPath()
  ctx.moveTo(left + r, top)
  ctx.lineTo(right - r, top)
  ctx.quadraticCurveTo(right, top, right, top + r)
  ctx.lineTo(right, bottom - r)
  ctx.quadraticCurveTo(right, bottom, right - r, bottom)
  ctx.lineTo(left + r, bottom)
  ctx.quadraticCurveTo(left, bottom, left, bottom - r)
  ctx.lineTo(left, top + r)
  ctx.quadraticCurveTo(left, top, left + r, top)
  ctx.closePath()
}

type GraphData = { nodes: FNode[]; links: FLink[] }
type FGRef = ForceGraphMethods<NodeObject<FNode>, LinkObject<FNode, FLink>>

/** Inject one synthetic project hub, linked to every session node, and mutate
 * sessions' degree/neighbors so hover/LOD stay correct. */
function addMainNode(data: GraphData, label: string, project = ''): void {
  const sessions = data.nodes.filter((n) => n.type === 'session')
  if (sessions.length === 0) return
  const mainId = `__main__${project}`
  const main: FNode = {
    id: mainId,
    type: 'main',
    label,
    bridge: false,
    degree: sessions.length,
    neighbors: new Set(sessions.map((s) => s.id)),
  }
  for (const s of sessions) {
    s.neighbors.add(mainId)
    s.degree += 1
    data.links.push({ source: mainId, target: s.id, relClass: 'next' })
  }
  data.nodes.push(main)
}

/** Imperative handle. Task 9 fills `growWith` (incremental session merge). Kept
 * as a clean seam now so callers can hold a ref without a later signature break. */
export type GraphViewHandle = {
  growWith?: (subgraph: GraphData) => void
}

export type GraphViewProps = {
  project: string
  projectName?: string
  reloadKey?: number // bump → refetch
  onSelectNode?: (n: FNode) => void
  onGraphMeta?: (m: { nodes: number; edges: number; settled: boolean }) => void
  onSessions?: (sessions: FNode[]) => void // primary project's session nodes → sidebar list
  highlightId?: string | null // external highlight (e.g. sidebar hover) → same focus/dim as hover
  askExpansionIds?: Set<string> | null // P2 seam: temp RAG expansion subgraph highlight
}

type Status = 'loading' | 'error' | 'ready'

export const GraphView = forwardRef<GraphViewHandle, GraphViewProps>(function GraphView(props, ref) {
  const { project, projectName, reloadKey, onGraphMeta, onSelectNode, onSessions, highlightId } = props

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const fgRef = useRef<FGRef | undefined>(undefined)
  const didFitRef = useRef(false)

  // ── Hover highlight (Task 7) + LOD label (Task 8) state, kept in refs so the
  // canvas accessors read live values without re-creating (stable identity → no
  // ForceGraph re-init → physics untouched). A single `hover` state bump drives
  // the tooltip + one re-render tick so the accessors are re-read.
  const dataRef = useRef<GraphData | null>(null)
  const maxDegreeRef = useRef(1)
  const hoverIdRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const highlightNodesRef = useRef<Set<string>>(new Set())
  const highlightLinksRef = useRef<Set<FLink>>(new Set())
  const askIdsRef = useRef<Set<string> | null>(null) // RAG expansion nodes → persistent highlight
  const pointerRef = useRef({ x: 0, y: 0 })
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const pulseCounterRef = useRef(0) // monotonic id so each growth fires a fresh ring

  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [status, setStatus] = useState<Status>('loading')
  const [coldStart, setColdStart] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const [data, setData] = useState<GraphData | null>(null)
  const [hover, setHover] = useState<FNode | null>(null) // hovered node → tooltip + tick
  const [, setAskTick] = useState(0) // re-render tick when RAG expansion changes
  const [pulse, setPulse] = useState<GrowthPulse | null>(null) // Growth Ring fire signal
  const [retryTick, setRetryTick] = useState(0) // error-overlay retry → re-fetch

  // Sync the RAG expansion set into a ref (canvas accessors read live) + one
  // re-render so drawNode/linkColor re-run. Highlights the answer's evidence
  // concepts on the graph ("질문하면 그래프가 근거로 반응") — dims the rest.
  useEffect(() => {
    askIdsRef.current = props.askExpansionIds && props.askExpansionIds.size ? props.askExpansionIds : null
    setAskTick((t) => t + 1)
  }, [props.askExpansionIds])

  // ── Task 9: incremental growth ────────────────────────────────────────────
  // Merge a freshly-fetched session subgraph into the LIVE graph without
  // relayout. mergeSubgraph reuses existing node OBJECTS by id, so d3-force keeps
  // their x/y/vx/vy — existing nodes barely move; only the new nodes (seeded near
  // their anchor) settle in. Then a calm reheat lets the local patch relax, and
  // the Growth Ring fires on the new session node.
  const growWith = useCallback((subgraph: GraphData) => {
    const existing = dataRef.current
    if (!existing) return
    const merged = mergeSubgraph(existing, subgraph)
    // Nothing genuinely new (e.g. a duplicate upload) → skip the pointless shake.
    if (merged.addedNodeIds.length === 0 && merged.links.length === existing.links.length) return

    const nextData: GraphData = { nodes: merged.nodes, links: merged.links }
    dataRef.current = nextData
    maxDegreeRef.current = nextData.nodes.reduce((m, n) => Math.max(m, n.degree), 1)
    // New top-level object → ForceGraph2D re-binds graphData. Because the existing
    // node OBJECTS are reused, d3 preserves their positions/velocities (no jump).
    setData(nextData)
    // The reheat below re-settles the newcomer → HUD reads "settling…" until
    // handleEngineStop flips it back to settled. Re-emit sessions so the sidebar
    // list + session count pick up the newly-added lecture (was stale).
    onGraphMeta?.({ nodes: nextData.nodes.length, edges: nextData.links.length, settled: false })
    onSessions?.(nextData.nodes.filter((n) => n.type === 'session'))

    // Revive + calm reheat AFTER ForceGraph re-binds the new data (next frame).
    // cooldownTicks stays 200 → the graph re-CALMS, it does not re-freeze dead.
    // The [data] tune effect also re-applies the Obsidian forces on the fresh
    // graph; this reheat is the explicit "settle the newcomer" nudge.
    requestAnimationFrame(() => {
      const fg = fgRef.current
      if (!fg) return
      fg.resumeAnimation()
      fg.d3ReheatSimulation()
    })

    // Fire the ring on the new session node (fallback: anchor, then first added).
    const sessionNew = merged.addedNodeIds
      .map((id) => nextData.nodes.find((n) => n.id === id))
      .find((n) => n?.type === 'session')
    const ringNodeId = sessionNew?.id ?? merged.anchorId ?? merged.addedNodeIds[0] ?? null
    if (ringNodeId) setPulse({ id: ++pulseCounterRef.current, nodeId: ringNodeId })
  }, [onGraphMeta, onSessions])

  useImperativeHandle(ref, () => ({ growWith }), [growWith])

  // Live screen-space position of a node id — the Growth Ring reads this each
  // frame so the ripple stays glued to the (still-settling) new session node.
  const getScreenPos = useCallback((nodeId: string) => {
    const fg = fgRef.current
    const node = dataRef.current?.nodes.find((n) => n.id === nodeId)
    if (!fg || !node || node.x == null || node.y == null) return null
    const p = fg.graph2ScreenCoords(node.x, node.y)
    return { x: p.x, y: p.y }
  }, [])

  // ── Measure parent (ForceGraph2D needs explicit width/height) ─────────────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Fetch → map → force data; seed cached x,y (NEVER fx/fy) ────────────────
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setColdStart(false)
    setErrMsg('')
    didFitRef.current = false

    const coldTimer = setTimeout(() => {
      if (!cancelled) setColdStart(true)
    }, COLD_START_MS)

    getGraph(project)
      .then((raw) => {
        if (cancelled) return
        const built = buildForceData(mapGraph(raw))
        const realNodes = built.nodes.length
        const realEdges = built.links.length
        const sessions = built.nodes.filter((n) => n.type === 'session')
        for (const node of built.nodes) node.project = project
        addMainNode(built, projectName || project)

        const cached = loadPositions(project)
        if (cached) {
          for (const node of built.nodes) {
            const position = cached[node.id]
            if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
              node.x = position.x
              node.y = position.y
            }
          }
        }

        dataRef.current = built
        maxDegreeRef.current = built.nodes.reduce((m, n) => Math.max(m, n.degree), 1)
        setData(built)
        setStatus('ready')
        onGraphMeta?.({ nodes: realNodes, edges: realEdges, settled: false })
        onSessions?.(sessions)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const msg = e instanceof ApiError ? e.message : '그래프를 불러오지 못했습니다.'
        setErrMsg(msg)
        setStatus('error')
      })
      .finally(() => clearTimeout(coldTimer))

    return () => {
      cancelled = true
      clearTimeout(coldTimer)
    }
  }, [project, projectName, reloadKey, retryTick, onGraphMeta, onSessions])

  // ── Tune d3-force like Obsidian, once per data load ───────────────────────
  // Runs after the graph mounts. Because ForceGraph2D only mounts once dims are
  // measured, we poll a few frames for fgRef instead of racing the child ref.
  useEffect(() => {
    if (!data || data.nodes.length === 0) return
    let raf = 0
    let tries = 0
    const apply = () => {
      const fg = fgRef.current
      if (!fg) {
        if (tries++ < 90) raf = requestAnimationFrame(apply)
        return
      }
      // d3Force returns a callable ForceFn (index-signature typed) — cast via
      // unknown to the d3 force accessors we actually call.
      // Concept relationships shape the knowledge map. Mention links remain
      // visible for provenance, but must not pull every concept into a star
      // around its recording node.
      const link = fg.d3Force('link') as unknown as {
        distance?: (fn: (l: { source: FNode | string; target: FNode | string; relClass?: string }) => number) => unknown
        strength?: (fn: (l: { source: FNode | string; target: FNode | string; relClass?: string }) => number) => unknown
      } | undefined
      link?.distance?.((l) => {
        const s = typeof l.source === 'object' ? l.source.type : undefined
        const t = typeof l.target === 'object' ? l.target.type : undefined
        if (s === 'main' || t === 'main') return 68
        if (l.relClass === 'mentions') return 46
        return 38
      })
      link?.strength?.((l) => {
        const s = typeof l.source === 'object' ? l.source.type : undefined
        const t = typeof l.target === 'object' ? l.target.type : undefined
        if (s === 'main' || t === 'main') return 0.1
        if (l.relClass === 'mentions') return 0.055
        return 0.22
      })
      const charge = fg.d3Force('charge') as unknown as { strength?: (fn: (n: FNode) => number) => unknown } | undefined
      charge?.strength?.((n: FNode) => {
        if (n.type === 'main') return -150
        if (n.type === 'session') return -65
        return -18 - Math.min(n.degree ?? 0, 8) * 4
      })
      const center = fg.d3Force('center') as unknown as { strength?: (s: number) => unknown } | undefined
      center?.strength?.(0.08)
      // Re-apply forces to the running sim (calm reheat — settles ~1.5–2s).
      fg.d3ReheatSimulation()
      // Dev-only test hook: exposes the graph instance + live node data so the
      // elasticity gate (headless) can grab a hub node and measure neighbor spring.
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__svxfg = fg
        ;(window as unknown as Record<string, unknown>).__svxdata = data
      }
    }
    apply()
    return () => cancelAnimationFrame(raf)
  }, [data])

  // ── Draw helpers ──────────────────────────────────────────────────────────
  const drawNode = useCallback(
    (node: NodeObject<FNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const degree = node.degree ?? 0
      const r = nodeRadius(degree, node.type)
      const color = nodeCoreColor(node.type, node.bridge ?? false)
      const x = node.x ?? 0
      const y = node.y ?? 0

      // Focus/dim: hover (Task 7) takes precedence; else the RAG expansion set
      // (evidence for the current answer) highlights + dims the rest.
      const hoverId = hoverIdRef.current
      const askIds = askIdsRef.current
      const hovering = hoverId !== null
      const asking = !hovering && !!askIds && askIds.size > 0
      const inAsk = asking && askIds!.has(node.id)
      let nodeAlpha = 1
      if (hovering) {
        if (node.id === hoverId) nodeAlpha = 1
        else if (highlightNodesRef.current.has(node.id)) nodeAlpha = 0.95
        else nodeAlpha = 0.12
      } else if (asking) {
        nodeAlpha = inAsk ? 1 : 0.1
      }

      const isMain = node.type === 'main'
      const isSession = node.type === 'session'
      const isFocused = node.id === hoverId || node.id === selectedIdRef.current || inAsk
      ctx.save()
      ctx.globalAlpha = nodeAlpha
      if (isMain) {
        // Project hub: restrained dark anchor with a paper keyline.
        ctx.beginPath()
        ctx.arc(x, y, r, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
        ctx.lineWidth = 2 / globalScale
        ctx.strokeStyle = NODE_PAPER
        ctx.stroke()
      } else if (isSession) {
        // Lecture/recording session: a soft filled tile, distinct from concepts.
        const size = r * 1.72
        roundedSquare(ctx, x, y, size, 3.2 / globalScale)
        ctx.fillStyle = SESSION_FILL
        ctx.fill()
        ctx.lineWidth = (isFocused ? 2 : 1.35) / globalScale
        ctx.strokeStyle = color
        ctx.stroke()
      } else {
        // Concepts stay circular; bridge concepts get a quiet moss fill.
        ctx.beginPath()
        ctx.arc(x, y, r, 0, 2 * Math.PI)
        ctx.fillStyle = node.bridge ? BRIDGE_FILL : NODE_PAPER
        ctx.fill()
        ctx.lineWidth = (isFocused ? 2 : node.bridge ? 1.6 : 1.25) / globalScale
        ctx.strokeStyle = color
        ctx.stroke()
      }
      // Evidence marker: a clean moss ring around RAG-cited nodes.
      if (inAsk) {
        ctx.globalAlpha = 1
        ctx.lineWidth = 1.8 / globalScale
        ctx.strokeStyle = '#66715B'
        ctx.beginPath()
        ctx.arc(x, y, r + 3.5 / globalScale, 0, 2 * Math.PI)
        ctx.stroke()
      }
      ctx.restore()

      // LOD labels: Task 8. Opacity only — the label position never changes, so
      // fading it in/out never shifts layout.
      // Main hub is always named. Session names appear at a useful zoom level;
      // concept labels still ramp by zoom to avoid a wall of text.
      const lodAlpha = isMain
        ? 1
        : node.type === 'session'
          ? isFocused || globalScale >= 0.78
            ? 1
            : 0
          : labelOpacity(globalScale, degree, maxDegreeRef.current, isFocused)
      // Backgrounded nodes' labels dim with them (so only the focus set reads).
      const labelAlpha = lodAlpha * (hovering || asking ? nodeAlpha : 1)
      if (labelAlpha > 0.02) {
        const fontSize = (isMain ? 14 : isSession ? 11.5 : 11) / globalScale
        const maxChars = isMain ? 28 : isSession ? 22 : 18
        const label = isFocused ? node.label : compactLabel(node.label, maxChars)
        ctx.save()
        ctx.globalAlpha = labelAlpha
        ctx.font = `${isMain || isSession ? 650 : 520} ${fontSize}px ${LABEL_FONT}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.shadowColor = 'rgba(255, 253, 247, 0.98)'
        ctx.shadowBlur = 3
        ctx.fillStyle = LABEL_INK
        ctx.fillText(label, x, y + r + 3 / globalScale)
        ctx.restore()
      }
    },
    [],
  )

  const paintPointer = useCallback(
    (node: NodeObject<FNode>, color: string, ctx: CanvasRenderingContext2D) => {
      const r = nodeRadius(node.degree ?? 0, node.type)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI)
      ctx.fill()
    },
    [],
  )

  // ── Interaction ─────────────────────────────────────────────────────────
  // Task 7: on hover, build the highlight set (node + its neighbors) and the
  // incident-link set into refs, then bump `hover` state for one re-render tick
  // (also drives the tooltip). onNodeHover(null) → clear. NO physics re-run.
  const handleNodeHover = useCallback((node: NodeObject<FNode> | null) => {
    const hlNodes = new Set<string>()
    const hlLinks = new Set<FLink>()
    if (node) {
      hlNodes.add(node.id)
      if (node.neighbors) for (const nb of node.neighbors) hlNodes.add(nb)
      for (const l of dataRef.current?.links ?? []) {
        if (endpointId(l.source) === node.id || endpointId(l.target) === node.id) hlLinks.add(l)
      }
    }
    highlightNodesRef.current = hlNodes
    highlightLinksRef.current = hlLinks
    hoverIdRef.current = node ? node.id : null
    setHover(node ? (node as FNode) : null)
  }, [])

  // External highlight (sidebar hover): drive the same focus/dim as a mouse hover.
  // Only fires when `highlightId` changes, so it never clobbers an active mouse
  // hover (the pointer is over the sidebar, not the canvas, when this changes).
  useEffect(() => {
    if (highlightId == null) {
      handleNodeHover(null)
      return
    }
    const node = dataRef.current?.nodes.find((n) => n.id === highlightId)
    if (node) handleNodeHover(node as NodeObject<FNode>)
  }, [highlightId, handleNodeHover])

  // Track pointer inside the canvas so the tooltip can float at the cursor.
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    pointerRef.current = { x, y }
    const tt = tooltipRef.current
    if (tt) {
      tt.style.left = `${x + 14}px`
      tt.style.top = `${y + 14}px`
    }
  }, [])

  // Hover-aware link color (Task 7): incident edges bright (~0.8), others faint.
  const linkColorAccessor = useCallback((l: LinkObject<FNode, FLink>) => {
    const base = linkColor(l.relClass)
    if (hoverIdRef.current !== null) {
      return highlightLinksRef.current.has(l as unknown as FLink) ? withAlpha(base, 0.82) : withAlpha(base, 0.045)
    }
    const askIds = askIdsRef.current
    if (askIds && askIds.size) {
      // Evidence subgraph: edges between two cited concepts stay bright, rest fade.
      return askIds.has(endpointId(l.source)) && askIds.has(endpointId(l.target)) ? withAlpha(base, 0.88) : withAlpha(base, 0.045)
    }
    return base
  }, [])

  const handleNodeClick = useCallback(
    (node: NodeObject<FNode>) => {
      selectedIdRef.current = node.id // keep its label shown (session labels need this)
      onSelectNode?.(node as FNode)
    },
    [onSelectNode],
  )

  // Keep the project hub where the user drops it; sub-nodes re-settle freely.
  const handleDragEnd = useCallback((node: NodeObject<FNode>) => {
    if (node.type === 'main') {
      node.fx = node.x
      node.fy = node.y
    } else {
      node.fx = undefined
      node.fy = undefined
    }
  }, [])

  // ── Settle: fires when the engine calms (bounded by cooldownTicks) ─────────
  const handleEngineStop = useCallback(() => {
    if (!data) return
    savePositions(project, data.nodes) // P2 cache for next load
    onGraphMeta?.({ nodes: data.nodes.length, edges: data.links.length, settled: true })
    const fg = fgRef.current
    if (fg && !didFitRef.current) {
      didFitRef.current = true
      fg.zoomToFit(400, 40)
    }
    // NOTE: intentionally NOT calling pauseAnimation() — force-graph's default
    // autoPauseRedraw already halts the idle redraw loop and revives it on
    // pointer interaction, which keeps drag elastic. A manual pauseAnimation()
    // risks a dead frame that a drag can't revive.
  }, [data, project, onGraphMeta])

  const showGraph = status === 'ready' && !!data && data.nodes.length > 0 && dims.w > 0 && dims.h > 0
  const isEmpty = status === 'ready' && !!data && data.nodes.length === 0

  return (
    <div
      ref={wrapRef}
      onMouseMove={handleMouseMove}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: `
          linear-gradient(90deg, rgba(234, 223, 201, 0.48) 0 1px, transparent 1px 56px),
          linear-gradient(180deg, rgba(234, 223, 201, 0.42) 0 1px, transparent 1px 56px),
          ${CANVAS_BG}
        `,
        overflow: 'hidden',
      }}
    >
      {showGraph && data && (
        <ForceGraph2D<FNode, FLink>
          ref={fgRef}
          graphData={data}
          width={dims.w}
          height={dims.h}
          backgroundColor={CANVAS_BG}
          cooldownTicks={200}
          d3VelocityDecay={0.4}
          d3AlphaDecay={0.03}
          enableNodeDrag
          onNodeDragEnd={handleDragEnd}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={paintPointer}
          linkColor={linkColorAccessor}
          linkWidth={(l: LinkObject<FNode, FLink>) =>
            l.relClass === 'next' || l.relClass === 'continues'
                ? 0.9
                : l.relClass === 'mentions'
                  ? 0.28
                  : 0.6
          }
          onNodeHover={handleNodeHover}
          onNodeClick={handleNodeClick}
          onEngineStop={handleEngineStop}
        />
      )}

      {/* Growth Ring (Task 9): purely-visual ripple over the new session node on
          incremental growth. pointer-events:none, never touches the sim → the
          graph cannot move. Cleared/settled by its own onDone. */}
      {showGraph && (
        <GrowthRing
          pulse={pulse}
          width={dims.w}
          height={dims.h}
          getScreenPos={getScreenPos}
          onDone={() => setPulse(null)}
        />
      )}

      {/* Floating hover tooltip (Task 7): label + type + 연결 N; follows the
          cursor via handleMouseMove; hidden (display:none) when not hovering. */}
      <div
        ref={tooltipRef}
        style={{
          position: 'absolute',
          left: pointerRef.current.x + 14,
          top: pointerRef.current.y + 14,
          display: hover ? 'block' : 'none',
          pointerEvents: 'none',
          zIndex: 5,
          maxWidth: 220,
          padding: '6px 8px',
          background: 'rgba(255, 253, 247, 0.96)',
          border: '1px solid #d9c8a8',
          borderRadius: 8,
          boxShadow: '0 10px 22px rgba(92, 72, 43, 0.12)',
          color: '#322B22',
        }}
      >
        {hover && (
          <>
            <div style={tooltipLabel}>{hover.label}</div>
            <div style={tooltipMeta}>
              {hover.type === 'main' ? '프로젝트' : hover.type === 'session' ? '녹음본' : hover.bridge ? '핵심 개념' : '개념'} · 연결 {hover.degree}
            </div>
          </>
        )}
      </div>

      {(status === 'loading' || status === 'error' || isEmpty) && (
        <Overlay>
          {status === 'loading' && (
            <>
              <div style={overlayTitle}>그래프 불러오는 중…</div>
              {coldStart && (
                <div style={overlaySub}>
                  서버를 깨우는 중입니다. 콜드 스타트 시 최대 50초까지 걸릴 수 있어요.
                </div>
              )}
            </>
          )}
          {status === 'error' && (
            <>
              <div style={overlayTitle}>그래프를 불러오지 못했어요</div>
              <div style={overlaySub}>{errMsg}</div>
              <button type="button" style={overlayRetry} onClick={() => setRetryTick((t) => t + 1)}>
                다시 시도
              </button>
            </>
          )}
          {isEmpty && (
            <>
              <div style={overlayTitle}>아직 그래프가 비어 있어요</div>
              <div style={overlaySub}>강의를 추가하면 개념 그래프가 자라납니다.</div>
            </>
          )}
        </Overlay>
      )}
    </div>
  )
})

// ── Canvas-filling overlay (loading / error / empty) ─────────────────────────
function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        textAlign: 'center',
        padding: 24,
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  )
}

const overlayTitle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 20,
  color: '#322B22',
}
const overlaySub: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: '#8B7B68',
  maxWidth: 360,
}

const overlayRetry: React.CSSProperties = {
  marginTop: 12,
  padding: '8px 18px',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: '#322B22',
  background: 'transparent',
  border: '1px solid #D9C8A8',
  borderRadius: 8,
  cursor: 'pointer',
  pointerEvents: 'auto', // the overlay wrapper is click-through; the button opts back in
}

const tooltipLabel: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  lineHeight: 1.3,
  fontWeight: 600,
}
const tooltipMeta: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: '#8B7B68',
  marginTop: 2,
}

export default GraphView
