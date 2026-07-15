// 백엔드(/graph, /projects) 응답 형식 — gsvx/engine.py graph()/list_projects() 그대로 매핑.

// `name` = server-stored human display name (e.g. "최적화개론") for a project whose
// group_id is an ASCII slug; absent for the seeded demo projects (labeled locally).
export type Project = { project: string; sessions: number; concepts: number; name?: string | null }

export type RawNode = {
  id: string
  type: string
  label: string
  meta: Record<string, unknown>
}

export type RawEdge = {
  src: string
  dst: string
  rel_type: string
  concept_id: string | null
  concept_label: string | null
  weight: number
}

export type GraphData = { nodes: RawNode[]; edges: RawEdge[] }

// /concept/{id}·/session/{id} 상세 — 백엔드(engine.concept_detail/session_detail)
// 응답을 client의 normalizer가 이 형태로 정규화한다(키 이름 차이 흡수):
//   concept: sessions[].session_id → sid, evidence 필드 제거.
//   session: concepts[].concept_id → id, text = segments[].text(없으면 summary).
export type ConceptDetail = {
  concept_id: string
  label: string
  summary: string | null
  sessions: { sid: string; title: string; snippet?: string }[]
}

export type SessionDetail = {
  session_id: string
  title: string
  text?: string
  concepts: { id: string; label: string }[]
}

// /ask 전체 응답 — 백엔드(gsvx/engine.ask)가 answer 외에 근거(hits)와 확장
// 서브그래프(expansion)까지 돌려준다. UI(AnswerDrawer)는 hits로 근거 세션을,
// expansion.nodes[].id로 그래프 임시 하이라이트를 만든다. hits/edges는 렌더 시
// 방어적으로 읽으므로 경계 타입은 unknown[]로 둔다.
export type AskResult = {
  answer: string
  hits: unknown[]
  expansion: { nodes: { id: string }[]; edges: unknown[] }
}
