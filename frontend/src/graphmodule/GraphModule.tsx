// GraphModule — the elastic knowledge-graph feature set, ported from
// click6067-ship-it/synapVOX (web/) as a self-contained, router-less module that
// drops into the team app's project view. Talks to the integration API's
// authenticated `/api` routes, scoped to the active project id. Styling is
// scoped under `.svx-graphmodule` so it never
// leaks into the team's global CSS.
import { useCallback, useRef, useState } from 'react'
import '@fontsource-variable/fraunces'
import '@fontsource/atkinson-hyperlegible'
import '@fontsource-variable/jetbrains-mono'
import GraphView from './graph/GraphView'
import type { FNode } from './graph/buildForceData'
import { AnswerDrawer } from './ask/AnswerDrawer'
import { useAsk } from './ask/useAsk'
import { CitationDrawer } from './detail/CitationDrawer'
import { DetailDrawer } from './detail/DetailDrawer'
import { useDetail } from './detail/useDetail'
import './graphmodule.css'

export default function GraphModule({
  project,
  projectName,
  reloadKey = 0,
  askExpansionIds = null,
  citation = null,
  onCitationClose,
  onResetFocus,
}: {
  project: string | null
  projectName: string
  reloadKey?: number
  askExpansionIds?: Set<string> | null
  // AI 채팅 인용 칩에서 넘어오는 근거 상세 — 있으면 노드 상세와 같은 드로어 자리에 띄운다.
  citation?: { n: number; title: string; fact: string } | null
  onCitationClose?: () => void
  // 새로고침 버튼이 AI 포커싱(askExpansionIds)까지 초기화할 수 있게 하는 콜백.
  onResetFocus?: () => void
}) {
  const [meta, setMeta] = useState({ nodes: 0, edges: 0, settled: false })
  const [refreshing, setRefreshing] = useState(false)
  const refreshTimerRef = useRef<number | null>(null)
  const [detailAskExpansion, setDetailAskExpansion] = useState<Set<string> | null>(null)
  const [panel, setPanel] = useState<'detail' | 'answer' | null>(null)
  const [localReloadKey, setLocalReloadKey] = useState(0)

  const base = project ?? ''
  const detail = useDetail(base)
  const ask = useAsk(base, setDetailAskExpansion)

  const onMeta = useCallback(
    (m: { nodes: number; edges: number; settled: boolean }) => {
      setMeta(m)
      // 빈 그래프는 엔진이 돌지 않아 settled 신호가 오지 않는다 — 데이터 도착으로 간주.
      if (m.settled || m.nodes === 0) setRefreshing(false)
    },
    [],
  )
  const onSelectNode = useCallback(
    (n: FNode) => {
      onCitationClose?.() // 노드를 누르면 인용 드로어 대신 노드 상세를 보여준다
      detail.open(n)
      setPanel('detail')
    },
    [detail, onCitationClose],
  )
  const closeDrawer = useCallback(() => {
    setPanel(null)
    detail.close()
    ask.clear()
  }, [detail, ask])
  const refresh = useCallback(() => {
    setRefreshing(true)
    setLocalReloadKey((key) => key + 1)
    closeDrawer()
    onCitationClose?.()
    onResetFocus?.()
    // 재조회 실패 시 settled 신호가 오지 않는다 — 버튼이 영구히 잠기지 않게 해제.
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = window.setTimeout(() => setRefreshing(false), 10_000)
  }, [closeDrawer, onCitationClose, onResetFocus])
  const drawer = citation ? (
    <CitationDrawer
      n={citation.n}
      title={citation.title}
      fact={citation.fact}
      onClose={() => onCitationClose?.()}
    />
  ) :
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
    return <div className="svx-graphmodule svx-gm--empty">프로젝트를 선택하면 지식 그래프가 나타납니다.</div>
  }

  return (
    <div className="svx-graphmodule">
      <div className="svx-gm__controls">
        <span className="svx-gm__scope-label">그래프 뷰</span>
        <button
          type="button"
          className={`svx-gm__refresh${refreshing ? ' svx-gm__refresh--spinning' : ''}`}
          onClick={refresh}
          disabled={refreshing}
          title="그래프 새로고침"
          aria-label="그래프 새로고침"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
        <span className="svx-gm__count">
          개념 {meta.nodes}개 · 연결 {meta.edges}개
        </span>
      </div>

      <div className="svx-gm__main">
        <div className="svx-gm__stage">
          <GraphView
            project={base}
            projectName={projectName}
            reloadKey={reloadKey + localReloadKey}
            onGraphMeta={onMeta}
            onSelectNode={onSelectNode}
            askExpansionIds={askExpansionIds ?? detailAskExpansion}
          />
        </div>
        {drawer ? <aside className="svx-gm__drawer">{drawer}</aside> : null}
      </div>
    </div>
  )
}
