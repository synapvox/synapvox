// 우측 답변 드로어. 학생이 답을 믿기 전에 근거를 먼저 보도록 — 근거 세션(hits)을
// 위에, 답변 텍스트를 아래에 둔다. hits는 경계 타입이 unknown[]이라(백엔드 키 변동
// 대비) 방어적으로 읽는다. Archive 미학: paper 위 Fraunces 제목 + 세션 라벨은 mono.
import type { AskResult } from '../api/types'
import './ask.css'

type HitLike = { session_id?: unknown; title?: unknown; text?: unknown; fact?: unknown }

// gsvx/engine.ask의 hits = {session_id(=세션 제목), text(=fact), score, ...}.
// 세션 라벨은 session_id(없으면 title), 근거 본문은 text(없으면 fact)에서 읽는다.
function readHit(h: unknown): { session: string; text: string } {
  const o = (h ?? {}) as HitLike
  const session =
    typeof o.session_id === 'string' && o.session_id
      ? o.session_id
      : typeof o.title === 'string'
        ? o.title
        : ''
  const text = typeof o.text === 'string' ? o.text : typeof o.fact === 'string' ? o.fact : ''
  return { session, text }
}

export function AnswerDrawer(props: {
  answer: AskResult | null
  busy: boolean
  error?: string | null
  onClose(): void
}): React.JSX.Element | null {
  const { answer, busy, error, onClose } = props

  // 답도 없고 로딩도 아니고 에러도 없으면 드로어는 비어 있음 → 렌더 안 함.
  if (!answer && !busy && !error) return null

  const hits = (answer?.hits ?? []).map(readHit).filter((h) => h.session || h.text)

  return (
    <aside className="answer-drawer" aria-label="답변" aria-busy={busy}>
      <header className="answer-drawer__head">
        <h2 className="answer-drawer__title">답변</h2>
        <button type="button" className="answer-drawer__close" onClick={onClose} aria-label="닫기">
          ×
        </button>
      </header>

      {error && !busy ? (
        <p className="answer-drawer__error" role="alert">{error}</p>
      ) : busy && !answer ? (
        <p className="answer-drawer__pending">그래프에서 근거를 찾는 중…</p>
      ) : (
        <div className="answer-drawer__body">
          {/* 근거 세션(hits) 먼저 — 학생이 근거를 확인한 뒤 답을 읽게 한다. */}
          <section className="answer-drawer__section">
            <h3 className="answer-drawer__label">
              근거 세션 <span className="answer-drawer__count">{hits.length}</span>
            </h3>
            {hits.length > 0 ? (
              <ul className="evidence-list">
                {hits.map((h, i) => (
                  <li className="evidence-item" key={i}>
                    {h.session && <span className="evidence-item__session">{h.session}</span>}
                    {h.text && <p className="evidence-item__text">{h.text}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="answer-drawer__empty">인용된 근거 세션이 없습니다.</p>
            )}
          </section>

          {/* 근거 아래에 답변 본문. */}
          <section className="answer-drawer__section">
            <h3 className="answer-drawer__label">답변</h3>
            <p className="answer-drawer__answer">
              {answer?.answer?.trim() || '관련한 근거를 찾지 못했어요. 다른 방식으로 질문해 보시겠어요?'}
            </p>
          </section>
        </div>
      )}
    </aside>
  )
}
