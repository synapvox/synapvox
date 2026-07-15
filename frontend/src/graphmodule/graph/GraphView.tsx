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
import { projectLabel } from './projectMeta'
import { computeCrossLinks } from './crossLinks'
import { makeMainRepel } from './mainRepel'

const CROSS_BLUE = '#5FB6D4' // shared-concept bridge ring (matches render.ts)

const CANVAS_BG = '#07120F' // literal hex — canvas ctx can't read a CSS var
const LABEL_INK = '#F4F0E7' // paper ink — readable label color on the dark canvas
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
  return `rgba(216, 255, 106, ${alpha})` // fallback = node-core lime
}

type GraphData = { nodes: FNode[]; links: FLink[] }
type FGRef = ForceGraphMethods<NodeObject<FNode>, LinkObject<FNode, FLink>>

/** Inject ONE synthetic "main" hub for a project, linked to every session node,
 * and mutate sessions' degree/neighbors so hover/LOD stay correct. The hub id is
 * namespaced by project so multiple projects can coexist in one galaxy view.
 * Sub-nodes (sessions + concepts) render hollow; the hub renders filled. */
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
  alsoShow?: string[] // other projects to render as additional main-hub clusters (galaxy)
  reloadKey?: number // bump → refetch
  onSelectNode?: (n: FNode) => void
  onGraphMeta?: (m: { nodes: number; edges: number; settled: boolean; cross?: number }) => void
  onSessions?: (sessions: FNode[]) => void // primary project's session nodes → sidebar list
  highlightId?: string | null // external highlight (e.g. sidebar hover) → same focus/dim as hover
  askExpansionIds?: Set<string> | null // P2 seam: temp RAG expansion subgraph highlight
}

type Status = 'loading' | 'error' | 'ready'

export const GraphView = forwardRef<GraphViewHandle, GraphViewProps>(function GraphView(props, ref) {
  const { project, alsoShow, reloadKey, onGraphMeta, onSelectNode, onSessions, highlightId } = props
  // Stable key so the fetch effect re-runs only when the actual set changes.
  const alsoKey = (alsoShow ?? []).slice().sort().join(',')

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
  const crossIdsRef = useRef<Set<string> | null>(null) // concepts shared across projects (교차연결)
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

    // Fetch the primary project + any galaxy extras; each becomes a main-hub
    // cluster. Sub-nodes (sessions + concepts) render hollow, hubs filled, and
    // the hubs repel each other strongly (mainRepel) → far-apart topic clusters.
    const toFetch = [project, ...alsoKey.split(',').filter(Boolean)].filter((p, i, a) => !!p && a.indexOf(p) === i)
    const multi = toFetch.length > 1
    Promise.all(toFetch.map((p) => getGraph(p).then((raw) => ({ p, built: buildForceData(mapGraph(raw)) }))))
      .then((results) => {
        if (cancelled) return
        const merged: GraphData = { nodes: [], links: [] }
        let realNodes = 0
        let realEdges = 0
        let primarySessions: FNode[] = []
        for (const { p, built } of results) {
          realNodes += built.nodes.length // real (pre-hub) counts → accurate HUD
          realEdges += built.links.length
          if (p === project) primarySessions = built.nodes.filter((n) => n.type === 'session')
          for (const n of built.nodes) n.project = p // tag for cross-project matching
          // One hub per project (namespaced when multiple coexist).
          addMainNode(built, projectLabel(p), multi ? p : '')
          merged.nodes.push(...built.nodes)
          merged.links.push(...built.links)
        }
        // 교차연결: when ≥2 projects are shown together, bridge concepts that
        // appear in both (normalized-label exact match) with 'cross' links.
        let crossCount = 0
        crossIdsRef.current = null
        if (multi) {
          const cross = computeCrossLinks(merged.nodes)
          if (cross.links.length) {
            merged.links.push(...cross.links)
            crossIdsRef.current = cross.crossIds
            crossCount = cross.links.length
          }
        }
        // Seed cached positions only in single-project mode (multi lets physics
        // place the clusters). Nodes stay FREE (no fx/fy).
        if (!multi) {
          const cached = loadPositions(project)
          if (cached) {
            for (const n of merged.nodes) {
              const c = cached[n.id]
              if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) {
                n.x = c.x
                n.y = c.y
              }
            }
          }
        }
        dataRef.current = merged
        maxDegreeRef.current = merged.nodes.reduce((m, n) => Math.max(m, n.degree), 1)
        setData(merged)
        setStatus('ready')
        onGraphMeta?.({ nodes: realNodes, edges: realEdges, settled: false, cross: crossCount })
        onSessions?.(primarySessions)
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
  }, [project, alsoKey, reloadKey, retryTick, onGraphMeta, onSessions])

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
      // Hub→session links sit a bit longer so sessions orbit the main; concept
      // links stay tight.
      const link = fg.d3Force('link') as unknown as {
        distance?: (fn: (l: { source: FNode | string; target: FNode | string; relClass?: string }) => number) => unknown
        strength?: (fn: (l: { source: FNode | string; target: FNode | string; relClass?: string }) => number) => unknown
      } | undefined
      link?.distance?.((l) => {
        if (l.relClass === 'cross') return 260 // long bridge across the cluster gap
        const s = typeof l.source === 'object' ? l.source.type : undefined
        const t = typeof l.target === 'object' ? l.target.type : undefined
        return s === 'main' || t === 'main' ? 110 : 55
      })
      // Cross links must be a WEAK, decorative bridge — strong enough to hint the
      // connection, too weak to yank the clusters together. Real links keep d3's
      // exact default strength (1/min(incident count)); we replicate it so their
      // tuned elasticity is untouched. Only applied when a cross link exists.
      const hasCross = data.links.some((l) => l.relClass === 'cross')
      if (hasCross) {
        const count: Record<string, number> = {}
        for (const l of data.links) {
          const s = endpointId(l.source)
          const t = endpointId(l.target)
          count[s] = (count[s] ?? 0) + 1
          count[t] = (count[t] ?? 0) + 1
        }
        link?.strength?.((l) => {
          if (l.relClass === 'cross') return 0.04
          const s = endpointId(l.source)
          const t = endpointId(l.target)
          return 1 / Math.min(count[s] ?? 1, count[t] ?? 1)
        })
      }
      const charge = fg.d3Force('charge') as unknown as { strength?: (fn: (n: FNode) => number) => unknown } | undefined
      // Main hubs push hard (their clusters spread apart); sub-nodes as before.
      charge?.strength?.((n: FNode) => (n.type === 'main' ? -1400 : -30 - (n.degree ?? 0) * 8))
      const center = fg.d3Force('center') as unknown as { strength?: (s: number) => unknown } | undefined
      center?.strength?.(0.04)
      // Custom force: keep the main hubs VERY far apart (galaxy of topics).
      ;(fg.d3Force as unknown as (name: string, force: unknown) => void)('mainRepel', makeMainRepel())
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
      ctx.save()
      ctx.globalAlpha = nodeAlpha
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      if (isMain) {
        // Main hub (e.g. 딥러닝): FILLED + strong glow — the topic center.
        ctx.shadowBlur = 22 * (nodeAlpha < 0.5 ? 0.3 : 1)
        ctx.shadowColor = color
        ctx.fillStyle = color
        ctx.fill()
      } else {
        // Sub-nodes (sessions + concepts): HOLLOW — outline ring only, no fill.
        ctx.shadowBlur = Math.min(4 + degree, 14) * (nodeAlpha < 0.5 ? 0.3 : 1)
        ctx.shadowColor = color
        ctx.lineWidth = 1.6 / globalScale
        ctx.strokeStyle = color
        ctx.stroke()
      }
      // Evidence marker: a rule-blue ring around RAG-cited concepts.
      if (inAsk) {
        ctx.globalAlpha = 1
        ctx.lineWidth = 1.5 / globalScale
        ctx.strokeStyle = '#2F6F86'
        ctx.beginPath()
        ctx.arc(x, y, r + 3 / globalScale, 0, 2 * Math.PI)
        ctx.stroke()
      }
      // 교차연결 marker: a bright rule-blue ring on concepts shared across projects
      // (the "연결점" between two topics). Dims with the node on hover/ask.
      if (!inAsk && crossIdsRef.current?.has(node.id)) {
        ctx.globalAlpha = nodeAlpha
        ctx.lineWidth = 1.6 / globalScale
        ctx.strokeStyle = CROSS_BLUE
        ctx.beginPath()
        ctx.arc(x, y, r + 3 / globalScale, 0, 2 * Math.PI)
        ctx.stroke()
      }
      ctx.restore()

      // LOD labels: Task 8. Opacity only — the label position never changes, so
      // fading it in/out never shifts layout.
      const isFocused = node.id === hoverId || node.id === selectedIdRef.current || inAsk
      // Main hub label always on; session labels only when hovered/selected;
      // concept labels ramp by zoom.
      const lodAlpha = isMain
        ? 1
        : node.type === 'session'
          ? isFocused
            ? 1
            : 0
          : labelOpacity(globalScale, degree, maxDegreeRef.current, isFocused)
      // Backgrounded nodes' labels dim with them (so only the focus set reads).
      const labelAlpha = lodAlpha * (hovering || asking ? nodeAlpha : 1)
      if (labelAlpha > 0.02) {
        const fontSize = (isMain ? 15 : 12) / globalScale // main label bigger; constant on-screen
        ctx.save()
        ctx.globalAlpha = labelAlpha
        ctx.font = `${fontSize}px ${LABEL_FONT}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.shadowColor = 'rgba(7, 18, 15, 0.9)' // canvas-dark halo for legibility
        ctx.shadowBlur = 3
        ctx.fillStyle = LABEL_INK
        ctx.fillText(node.label, x, y + r + 2 / globalScale)
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
      return highlightLinksRef.current.has(l as unknown as FLink) ? withAlpha(base, 0.8) : withAlpha(base, 0.05)
    }
    const askIds = askIdsRef.current
    if (askIds && askIds.size) {
      // Evidence subgraph: edges between two cited concepts stay bright, rest fade.
      return askIds.has(endpointId(l.source)) && askIds.has(endpointId(l.target)) ? withAlpha(base, 0.85) : withAlpha(base, 0.05)
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

  // Release behavior differs by tier:
  //   • main hub → PIN where dropped (keep fx/fy). The user arranges topic
  //     clusters by hand and they stay put; mainRepel skips pinned hubs, so
  //     dragging one hub never shoves the others (the reported bug).
  //   • sub-node → clear the pin so it re-settles elastically (Obsidian feel).
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
      style={{ position: 'relative', width: '100%', height: '100%', background: CANVAS_BG, overflow: 'hidden' }}
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
            l.relClass === 'cross'
              ? 1.4
              : l.relClass === 'next' || l.relClass === 'continues'
                ? 1.6
                : l.relClass === 'mentions'
                  ? 0.6
                  : 1
          }
          linkLineDash={(l: LinkObject<FNode, FLink>) =>
            l.relClass === 'cross' ? [6, 4] : l.relClass === 'mentions' ? [4, 3] : null
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
          background: 'rgba(7, 18, 15, 0.92)',
          border: '1px solid #16241f',
          color: '#F4F0E7',
        }}
      >
        {hover && (
          <>
            <div style={tooltipLabel}>{hover.label}</div>
            <div style={tooltipMeta}>
              {hover.type === 'session' ? '세션' : '개념'} · 연결 {hover.degree}
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
  color: '#F4F0E7',
}
const overlaySub: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: '#9aa39c',
  maxWidth: 360,
}

const overlayRetry: React.CSSProperties = {
  marginTop: 12,
  padding: '8px 18px',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: '#D8FF6A',
  background: 'transparent',
  border: '1px solid #D8FF6A',
  borderRadius: 4,
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
  color: '#9aa39c',
  marginTop: 2,
}

export default GraphView
