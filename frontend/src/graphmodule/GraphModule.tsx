// GraphModule — the elastic knowledge-graph feature set, ported from
// click6067-ship-it/synapVOX (web/) as a self-contained, router-less module that
// drops into the team app's project view. Talks to the SAME gsvx (Graphiti)
// backend the app already uses (VITE_API_BASE / VITE_API_KEY), scoped by the
// active project id. Brings: react-force-graph elastic physics · 4-tier node
// colors · graph modes (현재 과목 / 전체 / 교차연결) · RAG 질문 with evidence
// highlight · concept/session inspector. Styling is scoped under `.svx-graphmodule`
// so it never leaks into the team's global CSS.
import { useCallback, useEffect, useMemo, useState } from 'react'
import '@fontsource-variable/fraunces'
import '@fontsource/atkinson-hyperlegible'
import '@fontsource-variable/jetbrains-mono'
import GraphView from './graph/GraphView'
import type { FNode } from './graph/buildForceData'
import { projectLabel, rememberProjectNames } from './graph/projectMeta'
import { listProjects } from './api/client'
import type { Project } from './api/types'
import { AnswerDrawer } from './ask/AnswerDrawer'
import { useAsk } from './ask/useAsk'
import { DetailDrawer } from './detail/DetailDrawer'
import { useDetail } from './detail/useDetail'
import './graphmodule.css'

type Scope = 'project' | 'all' | 'cross'

export default function GraphModule({ project }: { project: string | null }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [scope, setScope] = useState<Scope>('project')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [meta, setMeta] = useState({ nodes: 0, edges: 0, settled: false, cross: 0 })
  const [askExpansion, setAskExpansion] = useState<Set<string> | null>(null)
  const [panel, setPanel] = useState<'detail' | 'answer' | null>(null)
  const [draft, setDraft] = useState('')

  const base = project ?? ''
  const detail = useDetail(base)
  const ask = useAsk(base, setAskExpansion)

  useEffect(() => {
    listProjects()
      .then((p) => {
        rememberProjectNames(p)
        setProjects(p)
      })
      .catch(() => {})
  }, [])

  // Follow the app's active project: reset to single-project scope on change.
  useEffect(() => {
    setScope('project')
  }, [project])

  const showProjects = useMemo(() => {
    if (scope === 'all') return projects.map((p) => p.project)
    if (scope === 'cross') return projects.map((p) => p.project).filter((p) => selected.has(p))
    return base ? [base] : []
  }, [scope, selected, projects, base])

  const focus = showProjects[0] ?? base
  const alsoShow = useMemo(() => showProjects.slice(1), [showProjects])
  const multi = showProjects.length > 1

  const onMeta = useCallback(
    (m: { nodes: number; edges: number; settled: boolean; cross?: number }) =>
      setMeta((prev) => ({ ...prev, ...m, cross: m.cross ?? prev.cross })),
    [],
  )
  const onSelectNode = useCallback(
    (n: FNode) => {
      detail.open(n)
      setPanel('detail')
    },
    [detail],
  )
  const submitAsk = useCallback(() => {
    const q = draft.trim()
    if (!q) return
    ask.ask(q)
    setPanel('answer')
    setDraft('')
  }, [draft, ask])
  const closeDrawer = useCallback(() => {
    setPanel(null)
    detail.close()
    ask.clear()
  }, [detail, ask])
  const toggle = (p: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const drawer =
    panel === 'detail' && detail.state.status !== 'idle' ? (
      <DetailDrawer
        state={detail.state}
        onClose={closeDrawer}
        onAskAbout={(label) => {
          ask.ask(`"${label}"이 무엇인지 이 강의들을 근거로 설명해줘`)
          setPanel('answer')
        }}
      />
    ) : panel === 'answer' ? (
      <AnswerDrawer answer={ask.answer} busy={ask.busy} error={ask.error} onClose={closeDrawer} />
    ) : null

  if (!base) {
    return <div className="svx-graphmodule svx-gm--empty">과목을 선택하면 지식 그래프가 나타납니다.</div>
  }

  return (
    <div className="svx-graphmodule">
      <div className="svx-gm__controls">
        <div className="svx-gm__seg" role="group" aria-label="그래프 범위">
          <button type="button" className={scope === 'project' ? 'is-active' : ''} onClick={() => setScope('project')}>
            현재 과목
          </button>
          <button type="button" className={scope === 'all' ? 'is-active' : ''} onClick={() => setScope('all')}>
            전체
          </button>
          <button type="button" className={scope === 'cross' ? 'is-active' : ''} onClick={() => setScope('cross')}>
            교차연결
          </button>
        </div>
        {scope === 'cross' ? (
          <div className="svx-gm__picks" aria-label="함께 볼 과목">
            {projects.map((p) => (
              <label key={p.project} className={selected.has(p.project) ? 'is-on' : ''}>
                <input type="checkbox" checked={selected.has(p.project)} onChange={() => toggle(p.project)} />
                {projectLabel(p.project)}
              </label>
            ))}
          </div>
        ) : null}
        <span className="svx-gm__count">
          {multi ? `${showProjects.length}과목 · ` : ''}
          {meta.nodes} concepts · {meta.edges} edges{meta.cross ? ` · 교차연결 ${meta.cross}` : ''}
        </span>
      </div>

      <div className="svx-gm__main">
        <div className="svx-gm__stage">
          <GraphView
            project={focus}
            alsoShow={alsoShow}
            onGraphMeta={onMeta}
            onSelectNode={onSelectNode}
            askExpansionIds={askExpansion}
          />
          <form className="svx-gm__ask" onSubmit={(e) => { e.preventDefault(); submitAsk() }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="그래프에 이 강의들에 대해 물어보세요"
              disabled={ask.busy}
              aria-label="그래프에 질문"
            />
            <button type="submit" disabled={ask.busy || draft.trim().length === 0}>
              {ask.busy ? '…' : '질문'}
            </button>
          </form>
        </div>
        {drawer ? <aside className="svx-gm__drawer">{drawer}</aside> : null}
      </div>
    </div>
  )
}
