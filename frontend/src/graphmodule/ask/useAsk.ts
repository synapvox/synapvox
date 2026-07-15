// RAG 질문 훅. ask(project,q)로 전체 응답(answer+hits+expansion)을 받아
// AnswerDrawer가 쓸 answer를 세팅하고, expansion.nodes[].id 집합을 onExpansion으로
// GraphView(askExpansionIds)에 흘려 임시 하이라이트를 만든다. 에러 전파는 ChatPanel과
// 동일한 규약: 알려진 한도(413 너무 김 / 429 너무 잦음)는 백엔드 메시지를 그대로,
// 그 외는 일반 안내.
import { useCallback, useRef, useState } from 'react'
import { ApiError, ask as askApi } from '../api/client'
import type { AskResult } from '../api/types'

export function useAsk(
  project: string,
  onExpansion: (ids: Set<string> | null) => void,
): { ask(q: string): void; answer: AskResult | null; busy: boolean; error: string | null; clear(): void } {
  const [answer, setAnswer] = useState<AskResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // onExpansion은 매 렌더 새 참조일 수 있으니 ref로 잡아 ask 콜백을 안정화한다.
  const onExpansionRef = useRef(onExpansion)
  onExpansionRef.current = onExpansion

  // Request generation: bumped on every ask AND on clear(). A resolving request
  // whose gen no longer matches has been superseded (project switched, cleared,
  // or re-asked) — it must NOT write its answer/expansion into the shared state.
  // This hook now persists across project switches (AppLayout's right rail), so
  // an in-flight P1 answer could otherwise land under P2.
  const genRef = useRef(0)

  const clear = useCallback(() => {
    genRef.current += 1 // invalidate any in-flight request
    setAnswer(null)
    setError(null)
    setBusy(false)
    onExpansionRef.current(null)
  }, [])

  const ask = useCallback(
    (q: string) => {
      const query = q.trim()
      if (!query || busy) return
      setBusy(true)
      setError(null)
      const gen = (genRef.current += 1)
      void (async () => {
        try {
          const result = await askApi(project, query)
          if (gen !== genRef.current) return // superseded → drop
          setAnswer(result)
          // Defensive: an answer may arrive without an expansion subgraph — a
          // missing/empty expansion must not throw the success path into catch.
          const ids = result.expansion?.nodes?.map((n) => n.id) ?? []
          onExpansionRef.current(ids.length ? new Set(ids) : null)
        } catch (e) {
          if (gen !== genRef.current) return // superseded → drop
          const message =
            e instanceof ApiError && (e.status === 413 || e.status === 429)
              ? e.message
              : '답변을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.'
          setError(message)
          setAnswer(null)
          onExpansionRef.current(null)
        } finally {
          if (gen === genRef.current) setBusy(false)
        }
      })()
    },
    [project, busy],
  )

  return { ask, answer, busy, error, clear }
}
