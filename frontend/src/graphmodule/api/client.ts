import type { AskResult, ConceptDetail, GraphData, SessionDetail } from './types'
import { supabase } from '../../supabaseClient'

const BASE = '/api'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A non-2xx API response. `status` lets callers special-case caps/limits
 * (413 too long, 429 limit reached) vs. generic failure; `message` carries the
 * backend's `detail` when present. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function req(path: string, opts: RequestInit = {}, method = 'GET'): Promise<Response> {
  const backoff = [400, 1000, 2000]
  for (let a = 0; ; a++) {
    if (a > 0) await sleep(backoff[a - 1])
    let r: Response
    try {
      const token = (await supabase?.auth.getSession())?.data.session?.access_token
      r = await fetch(`${BASE}${path}`, {
        ...opts,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
      })
    } catch (e) {
      if (method === 'GET' && a < backoff.length) continue
      throw e
    }
    const edgeDown = r.status === 404 && r.headers.get('x-render-routing') === 'no-server'
    if ((edgeDown || (method === 'GET' && r.status >= 502)) && a < backoff.length) continue
    return r
  }
}

/** Parse a JSON body, but REJECT (throw ApiError) on any non-2xx — so a failed
 * ingest never resolves and lets the UI navigate to a broken workspace, and
 * reads never silently consume an error-shaped payload. */
async function jsonOrThrow(r: Response): Promise<unknown> {
  if (r.ok) return r.json()
  let detail = ''
  try {
    const body = (await r.json()) as { detail?: string }
    detail = typeof body?.detail === 'string' ? body.detail : ''
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(r.status, detail || `요청에 실패했습니다 (${r.status})`)
}

export async function getGraph(project: string): Promise<GraphData> {
  return (await jsonOrThrow(await req(`/graph?project=${encodeURIComponent(project)}`))) as GraphData
}

/** Returns the FULL backend body — `answer` plus `hits` (근거 세션) and
 * `expansion` (RAG subgraph for temporary graph highlight). Backward compatible:
 * callers that only read `.answer` still work. */
export async function ask(project: string, q: string): Promise<AskResult> {
  return (await jsonOrThrow(
    await req(`/ask?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}&k=6`),
  )) as AskResult
}

// ── 상세 조회 (concept/session) ─────────────────────────────
// 백엔드 engine.concept_detail/session_detail 응답을 types.ts의 ConceptDetail/
// SessionDetail로 정규화한다(키 이름이 다르고 UI가 안 쓰는 필드가 딸려 오므로).

type RawConceptDetail = {
  concept_id: string
  label: string
  summary: string | null
  sessions?: { session_id: string; title: string }[]
}

type RawSessionDetail = {
  session_id: string
  title: string
  summary?: string | null
  concepts?: { concept_id: string; label: string }[]
  segments?: { text?: string | null }[]
}

function normalizeConcept(raw: RawConceptDetail): ConceptDetail {
  return {
    concept_id: raw.concept_id,
    label: raw.label,
    summary: raw.summary ?? null,
    sessions: (raw.sessions ?? []).map((s) => ({ sid: s.session_id, title: s.title })),
  }
}

function normalizeSession(raw: RawSessionDetail): SessionDetail {
  // 백엔드엔 최상위 text가 없다 — segments 본문을 이어 붙이고, 없으면 summary로 폴백.
  const body = (raw.segments ?? [])
    .map((s) => s.text ?? '')
    .filter(Boolean)
    .join('\n\n')
  return {
    session_id: raw.session_id,
    title: raw.title,
    text: body || raw.summary || undefined,
    concepts: (raw.concepts ?? []).map((c) => ({ id: c.concept_id, label: c.label })),
  }
}

export async function getConcept(project: string, id: string): Promise<ConceptDetail> {
  const raw = (await jsonOrThrow(
    await req(`/concept/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`),
  )) as RawConceptDetail
  return normalizeConcept(raw)
}

export async function getSession(project: string, id: string): Promise<SessionDetail> {
  const raw = (await jsonOrThrow(
    await req(`/session/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`),
  )) as RawSessionDetail
  return normalizeSession(raw)
}
