# integration — 통합 API와 E2E 파이프라인

`integration`은 STT, 자료 추출, `graphrag`를 조립한다. 그래프 스키마·저장·검색은
`backend/graphrag`가 소유하고, 이 폴더는 프론트가 사용할 API와 처리 순서를 담당한다.

## 구조

### `api/main.py`

FastAPI 서버의 진입점이다. Supabase JWT를 검증한 뒤 기존 모듈을 조합한다.

| 엔드포인트 | 처리 |
|---|---|
| `GET /api/health` | 서버 상태 확인 |
| `POST /api/stt/transcribe` | CLOVA 전사 → 자료 기반 2차 보정 → 중간포맷 JSON |
| `POST /api/ingest-stt` | `pipeline.ingest_intermediate` → Neo4j + pgvector |
| `POST /api/ingest-doc` | 자료 텍스트 추출 → `pipeline.ingest_document_text` → Neo4j + pgvector |
| `GET /api/graph` | `graphrag.queries.graph_data`로 현재 프로젝트 그래프 조회 |
| `GET /api/ask` | `graphrag.HybridSearch`로 벡터 검색·그래프 확장 후 답변 |
| `GET /api/concept/{id}` | 개념과 연결 강의 조회 |
| `GET /api/session/{id}` | 강의/자료 세션의 청크와 개념 조회 |

그래프 관련 API는 모두 `Authorization: Bearer <Supabase JWT>`가 필요하다. 적재와 조회는
`X-Project-Id` 또는 `project` 쿼리로 프로젝트 범위를 고정한다. 녹음 전용 참고자료는
`X-Meeting-Id`를 보내 같은 녹음 세션에 연결한다.

### `pipeline.py`

기존 E2E 오케스트레이션 계층이다.

- `extract_text(path)`: pdf/pptx/docx/md/txt → 평문
- `chunk_transcript(im)`, `chunk_document(text, doc_id)`: 전사·자료 청킹
- `extract_chunk_topics(...)`: 기존 STT 키워드 추출기를 `llm_extraction` Topic 계약으로 변환
- `ingest_intermediate(...)`: 인메모리 STT 결과 → `GraphStore`/`VectorStore`
- `ingest_document_text(...)`: 인메모리 자료 → `GraphStore`/`VectorStore`
- `ingest_files(...)`: 파일 기반 CLI/E2E 적재 경로

```text
자료 ── 텍스트 추출 ─┐
                    ├─ pipeline ─┬─ GraphStore ── Neo4j
녹음 ─ CLOVA 전사 ──┘            └─ VectorStore ─ Supabase pgvector
                                      │
프론트 그래프 ◀─ /api/graph ◀────────┤
프론트 질문   ◀─ /api/ask  ◀─ HybridSearch
```

### `gsvx_connector.py`

외부 Graphiti 서버와 연동해야 할 때 사용할 수 있는 레거시/선택형 커넥터다. 현재 프론트와
`api/main.py`의 기본 실행 경로에서는 호출하지 않는다.

## 환경변수

- Neo4j: `NEO4J_URI`, `NEO4J_USERNAME`(또는 `NEO4J_USER`), `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- Supabase Auth: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- pgvector: `SUPABASE_DB_URL` (Session Pooler 권장)
- 모델: `OPENAI_API_KEY`, 선택 `OPENAI_CHAT_MODEL`
- STT: `CLOVA_SPEECH_INVOKE_URL`, `CLOVA_SPEECH_SECRET`

## 실행과 검증

```bash
/opt/homebrew/bin/python3.12 -m uvicorn backend.integration.api.main:app --reload --port 8000
/opt/homebrew/bin/python3.12 -m pytest backend/integration/tests backend/graphrag/tests -q
```
