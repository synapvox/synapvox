// GraphModule — the elastic knowledge-graph feature set, ported from
// click6067-ship-it/synapVOX (web/) as a self-contained, router-less module that
// drops into the team app's project view. Talks to the SAME gsvx (Graphiti)
// backend the app already uses (VITE_API_BASE / VITE_API_KEY), scoped to the
// active project id. Styling is scoped under `.svx-graphmodule` so it never
// leaks into the team's global CSS.
import { useCallback, useState } from 'react'
import '@fontsource-variable/fraunces'
import '@fontsource/atkinson-hyperlegible'
import '@fontsource-variable/jetbrains-mono'
import GraphView from './graph/GraphView'
import type { FNode } from './graph/buildForceData'
import { AnswerDrawer } from './ask/AnswerDrawer'
import { useAsk } from './ask/useAsk'
import { DetailDrawer } from './detail/DetailDrawer'
import { useDetail } from './detail/useDetail'
import './graphmodule.css'

export default function GraphModule({ project, projectName, reloadKey = 0 }: { project: string | null; projectName: string; reloadKey?: number }) {
  const [meta, setMeta] = useState({ nodes: 0, edges: 0, settled: false })
  const [askExpansion, setAskExpansion] = useState<Set<string> | null>(null)
  const [panel, setPanel] = useState<'detail' | 'answer' | null>(null)
  const [draft, setDraft] = useState('')

  const base = project ?? ''
  const detail = useDetail(base)
  const ask = useAsk(base, setAskExpansion)

  const onMeta = useCallback(
    (m: { nodes: number; edges: number; settled: boolean }) => setMeta(m),
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
    return <div className="svx-graphmodule svx-gm--empty">프로젝트를 선택하면 지식 그래프가 나타납니다.</div>
  }

  return (
    <div className="svx-graphmodule">
      <div className="svx-gm__controls">
        <span className="svx-gm__scope-label">현재 프로젝트</span>
        <span className="svx-gm__count">
          개념 {meta.nodes}개 · 연결 {meta.edges}개
        </span>
      </div>

      <div className="svx-gm__main">
        <div className="svx-gm__stage">
          <GraphView
            project={base}
            projectName={projectName}
            reloadKey={reloadKey}
            onGraphMeta={onMeta}
            onSelectNode={onSelectNode}
            askExpansionIds={askExpansion}
          />
          <form className="svx-gm__ask" onSubmit={(e) => { e.preventDefault(); submitAsk() }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="프로젝트 자료와 녹음본에 대해 질문하세요"
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
