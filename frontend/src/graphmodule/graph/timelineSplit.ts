// 시간순 레이아웃 전용 변환: 여러 세션이 공유하는 개념(브리지 노드)을 세션별 사본으로
// 분리한다. 공유 개념은 여러 세션 x 사이로 끌려가 가운데 몰리는데, 세션마다 자기 사본을
// 두면 각 사본이 해당 세션 x 주변에 자연스레 모인다. 원본 그래프는 그대로 두고 렌더용
// 데이터만 바꾸는 '시각화 전용' 변환이다. (a—b—c에서 b가 공유면 a—b, b'—c로 갈라짐)
import type { FNode, FLink, FRelClass } from './buildForceData'

type GraphData = { nodes: FNode[]; links: FLink[] }

const endId = (e: string | FNode): string => (typeof e === 'string' ? e : e.id)

export function splitSharedForTimeline(data: GraphData): GraphData {
  const isSession = new Map<string, boolean>()
  for (const n of data.nodes) isSession.set(n.id, n.type === 'session')

  // 개념 id → 그 개념을 언급한 세션 id 집합
  const mentioners = new Map<string, Set<string>>()
  for (const l of data.links) {
    if (l.relClass !== 'mentions') continue
    const s = endId(l.source)
    const t = endId(l.target)
    const sess = isSession.get(s) ? s : isSession.get(t) ? t : null
    if (!sess) continue
    const concept = sess === s ? t : s
    let set = mentioners.get(concept)
    if (!set) mentioners.set(concept, (set = new Set()))
    set.add(sess)
  }

  const shared = new Set<string>()
  for (const [c, ss] of mentioners) if (ss.size >= 2) shared.add(c)
  if (shared.size === 0) return data // 공유 개념 없으면 원본 그대로

  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const copyId = (c: string, s: string) => `${c}::${s}`

  // 노드: 세션·비공유 개념은 원본 객체 재사용(위치·핀 유지), 공유 개념만 세션별 사본
  const nodes: FNode[] = data.nodes.filter((n) => !shared.has(n.id))
  for (const c of shared) {
    const orig = byId.get(c)
    if (!orig) continue
    for (const s of mentioners.get(c) ?? []) {
      nodes.push({
        ...orig, id: copyId(c, s), bridge: false, degree: 0,
        neighbors: new Set<string>(), x: undefined, y: undefined, fx: undefined, fy: undefined,
      })
    }
  }
  const nodeIds = new Set(nodes.map((n) => n.id))

  // 개념이 특정 세션 맥락에서 가리키는 대표 id(공유면 그 세션 사본)
  const repr = (id: string, sess: string) => (shared.has(id) ? copyId(id, sess) : id)

  const links: FLink[] = []
  const seen = new Set<string>()
  const add = (src: string, tgt: string, rel: FRelClass) => {
    if (!nodeIds.has(src) || !nodeIds.has(tgt) || src === tgt) return
    const key = `${src}->${tgt}:${rel}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ source: src, target: tgt, relClass: rel })
  }

  for (const l of data.links) {
    const s = endId(l.source)
    const t = endId(l.target)
    if (l.relClass === 'mentions') {
      const sess = isSession.get(s) ? s : t
      const concept = sess === s ? t : s
      add(sess, repr(concept, sess), 'mentions')
    } else {
      // 개념-개념(또는 허브): 공통 세션에서 각 사본을 연결해 맥락을 로컬화
      const ssS = mentioners.get(s) ?? new Set<string>()
      const ssT = mentioners.get(t) ?? new Set<string>()
      const common = [...ssS].filter((x) => ssT.has(x))
      if (common.length > 0) {
        for (const cs of common) add(repr(s, cs), repr(t, cs), l.relClass)
      } else {
        // 공통 세션이 없으면 대표 사본끼리 이어 연결이 끊기지 않게 한다
        const rs = shared.has(s) ? copyId(s, [...ssS][0] ?? '') : s
        const rt = shared.has(t) ? copyId(t, [...ssT][0] ?? '') : t
        add(rs, rt, l.relClass)
      }
    }
  }

  // 같은 개념의 사본들을 점선으로 이어 '원래 한 노드였음'을 표시(연결 상태 유지).
  // dashed 링크는 렌더만 하고 force는 0으로 둬야 사본이 다시 뭉치지 않는다(GraphView).
  for (const c of shared) {
    const copies = [...(mentioners.get(c) ?? [])].map((s) => copyId(c, s))
    for (let i = 0; i + 1 < copies.length; i++) {
      links.push({ source: copies[i], target: copies[i + 1], relClass: 'cooccur', dashed: true })
    }
  }

  // degree/neighbors 재계산(점선 사본 링크는 제외 — 반지름·hover를 부풀리지 않게)
  const byNew = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    if (shared.has(n.id)) continue // 원본 공유 개념은 nodes에 없음
    n.degree = 0
    n.neighbors = new Set<string>()
  }
  for (const l of links) {
    if (l.dashed) continue
    const a = byNew.get(endId(l.source))
    const b = byNew.get(endId(l.target))
    if (a) { a.degree += 1; a.neighbors.add(endId(l.target)) }
    if (b) { b.degree += 1; b.neighbors.add(endId(l.source)) }
  }

  return { nodes, links }
}
