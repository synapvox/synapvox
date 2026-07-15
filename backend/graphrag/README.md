# graphrag — ③④ Vector/Graph DB · 검색

담당: 용하

## Baseline
- Graph DB 스키마 구현·적재 로직 (Neo4j)
- Vector DB 구축 (pgvector 또는 Chroma)
- 하이브리드 검색: Vector top-k → 그래프 이웃 확장 → 재정렬
- 시간별·맥락별 조회 쿼리 (Cypher)

## 고도화
- 검색 재정렬 튜닝
- Entity Store SSOT · 교차 링킹
- 크로스 프로젝트 검색
- 관리형 DB로 이전

## 소유 스키마
Graph/Vector DB 스키마 — 노드/엣지 정의. → [`schemas/graph_vector_db.md`](../../schemas/graph_vector_db.md)

---

## 구현 (v0.1 — feat/graphrag-store-and-search, 2026-07-13)

`schemas/graph_vector_db.md` draft를 그대로 구현. **plain Neo4j + Chroma**. integration(D)이 함수로 소비.

| 파일 | 역할 |
| --- | --- |
| `schema.py` | Neo4j 노드/엣지 상수 + 제약(모든 노드 `(project_id, key)` 유니크) |
| `graph_store.py` | 적재: `load_intermediate`(→Project·Meeting) · `load_chunks`(→Chunk) · `load_extraction`(→Topic·Decision·ActionItem + DISCUSSES/DECIDED_IN/RAISED_IN/SUPERSEDES). FOLLOWS는 date 순 자동 |
| `vector_store.py` | Chroma 청크 임베딩. `embed_fn` 주입식(기본=의존성 없는 해싱, 실서비스는 OpenAI 등). 메타 필터 `project_id/meeting_id/source_type` |
| `search.py` | `HybridSearch.search` — 벡터 top-k → 그래프 이웃(주제·회의) 확장 → 공유주제 가중 재정렬 |
| `queries.py` | `timeline`(FOLLOWS) · `meetings_by_topic`(DISCUSSES) · `decision_history`(SUPERSEDES) |

**입력 계약 메모(도윤·B와 확인 필요)**: `load_chunks`/`add_chunks`가 받는 청크는
`{chunk_id, source_type, raw_span, timestamps, text}` 형태로 가정했습니다. chunking 산출 청크 포맷을
`schemas/`에 명시하면 맞추겠습니다. `schemas/graph_vector_db.md`는 손대지 않았습니다(draft 그대로 구현).

**레퍼런스**: 팀 스키마와 별개로, 동일 아이디어(세션 간 개념 연결 + GraphRAG)를 end-to-end로 돌려본
단독 프로토타입 — https://github.com/click6067-ship-it/synapVOX (커스텀판 + Graphiti판). 하이브리드 검색·Neo4j
적재·시각화·RAG 답변을 실제로 확인해볼 수 있습니다. 가져다 참고용.

---

## `vector_store.py`: Chroma → pgvector 전환 (2026-07-15, 팀 결정 — 공통 벡터 스토어로 Supabase 채택)

`schemas/graph_vector_db.md`가 애매하게 both 취급하던 "pgvector(또는 Chroma)" 중 pgvector 경로로 확정,
`vector_store.py`를 직접 교체했습니다. **공개 인터페이스(`add_chunks`/`query`/`reset`, `embed_fn` 주입식)는
그대로**라 `__init__.py`/`search.py` 등 소비 코드는 변경 없습니다.

- 연결: `SUPABASE_DB_URL` 환경변수(Postgres 연결문자열). **Session Pooler 문자열 사용 필수** —
  Direct connection 호스트(`db.<ref>.supabase.co`)는 IPv6 전용이라 IPv6 미지원 네트워크에서
  `could not translate host name` 에러로 연결 실패함. 대시보드 Connect → Session pooler에서 복사.
- 테이블: `chunks`(`VectorStore.__init__`에서 자동 생성, `CREATE EXTENSION IF NOT EXISTS vector` 포함) —
  `chunk_id` PK로 upsert.
- `chromadb` 의존성 제거, `psycopg2-binary` 추가 (`requirements.txt`).
- 테스트: `pytest backend/graphrag/tests/`가 이제 Neo4j **와** `SUPABASE_DB_URL` 둘 다 필요 — 기존
  `test_vector_store_project_isolation`에 skip 가드 추가 + `test_vector_store_upsert_overwrites_same_chunk_id`
  신규 추가. 실제 Supabase 프로젝트 대상 round-trip 검증 완료(관련 청크가 코사인 거리 기준 상위로 랭크됨,
  project_id 격리, upsert 덮어쓰기).
- pgvector 컬럼을 고정 차원 없이(`VECTOR`, unconstrained) 선언 — `embed_fn`을 바꾸면(예: 해싱 256차원 ↔
  OpenAI 1536차원) 같은 테이블 안에 차원이 다른 벡터가 섞일 수 있음. 하나의 `VectorStore` 인스턴스가
  항상 같은 `embed_fn`을 쓴다고 가정. ANN 인덱스(ivfflat/hnsw) 없이 전체 스캔 — MVP 규모에서는 문제없음.
