// DetailDrawer — right paper drawer showing concept/session detail on node click.
// Concept: label (Fraunces) + summary + connected sessions + "이 개념 질문".
// Session: title + truncated text snippet + extracted-concept chips.
// Header ✕ and Esc both close. Archive aesthetic: flat paper, hairline rules,
// no rounded "card" look (radius only 0/4 per tokens). Renders null when idle.
import { useEffect } from 'react'
import type { JSX } from 'react'
import type { ConceptDetail, SessionDetail } from '../api/types'
import type { DetailState } from './useDetail'
import './detail.css'

const SNIPPET_MAX = 400

/** Trim to a readable snippet on a whitespace-friendly boundary, with an ellipsis. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

export function DetailDrawer(props: {
  state: DetailState
  onClose(): void
  onAskAbout(label: string): void
}): JSX.Element | null {
  const { state, onClose, onAskAbout } = props
  const isOpen = state.status !== 'idle'

  // Esc closes while the drawer is open (mirrors the header ✕).
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="detail" role="complementary" aria-label="상세">
      <header className="detail__head">
        <span className="detail__kind">{state.kind === 'concept' ? '개념' : '세션'}</span>
        <button type="button" className="detail__close" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </header>

      <div className="detail__body">
        {/* Keep the label visible while loading/erroring so the drawer never blanks. */}
        {state.status !== 'ready' && state.label ? (
          <h2 className="detail__title">{state.label}</h2>
        ) : null}

        {state.status === 'loading' ? <p className="detail__status">불러오는 중…</p> : null}
        {state.status === 'error' ? (
          <p className="detail__status detail__status--error">상세를 불러오지 못했습니다.</p>
        ) : null}

        {state.status === 'ready' && state.kind === 'concept' && state.concept ? (
          <ConceptView concept={state.concept} onAskAbout={onAskAbout} />
        ) : null}
        {state.status === 'ready' && state.kind === 'session' && state.session ? (
          <SessionView session={state.session} />
        ) : null}
      </div>
    </div>
  )
}

function ConceptView(props: {
  concept: ConceptDetail
  onAskAbout(label: string): void
}): JSX.Element {
  const { concept, onAskAbout } = props
  return (
    <>
      <h2 className="detail__title">{concept.label}</h2>

      {concept.summary ? (
        <p className="detail__summary">{concept.summary}</p>
      ) : (
        <p className="detail__summary detail__summary--empty">요약이 아직 없습니다.</p>
      )}

      <section className="detail__section">
        <h3 className="detail__section-title">
          연결된 세션 <span className="detail__count">{concept.sessions.length}</span>
        </h3>
        {concept.sessions.length > 0 ? (
          <ul className="detail__sessions">
            {concept.sessions.map((s) => (
              <li key={s.sid} className="detail__session">
                <span className="detail__session-title">{s.title}</span>
                {s.snippet ? <span className="detail__session-snippet">{s.snippet}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="detail__empty">아직 연결된 세션이 없습니다.</p>
        )}
      </section>

      <button
        type="button"
        className="detail__ask"
        onClick={() => onAskAbout(concept.label)}
      >
        이 개념 질문
      </button>
    </>
  )
}

function SessionView(props: { session: SessionDetail }): JSX.Element {
  const { session } = props
  const snippet = session.text ? truncate(session.text, SNIPPET_MAX) : ''
  return (
    <>
      <h2 className="detail__title">{session.title}</h2>

      {snippet ? (
        <p className="detail__snippet">{snippet}</p>
      ) : (
        <p className="detail__snippet detail__snippet--empty">원문 스니펫이 없습니다.</p>
      )}

      <section className="detail__section">
        <h3 className="detail__section-title">
          추출된 개념 <span className="detail__count">{session.concepts.length}</span>
        </h3>
        {session.concepts.length > 0 ? (
          <ul className="detail__chips">
            {session.concepts.map((c) => (
              <li key={c.id} className="detail__chip">
                {c.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="detail__empty">추출된 개념이 없습니다.</p>
        )}
      </section>

      {/* prev/next 세션 네비게이션: 현재 SessionDetail 타입에 인접 세션 정보가 없고
          DetailDrawer 시그니처에도 네비게이션 콜백이 없어 렌더할 데이터가 없다.
          백엔드/타입이 prev/next를 제공하게 되면 여기에 이전·다음 링크를 추가한다. */}
    </>
  )
}
