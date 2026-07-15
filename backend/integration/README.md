# integration — 통합 API와 E2E 파이프라인

`integration`은 STT와 자료 추출 결과를 Graphiti(gsvx) 서비스에 연결한다. 이 폴더는
Supabase 인증을 유지하면서 프론트가 사용할 적재·조회·질문 API를 릴레이한다.

## 구조

### `api/main.py`

FastAPI 서버의 진입점이다. Supabase JWT를 검증한 뒤 기존 모듈을 조합한다.

| 엔드포인트 | 처리 |
|---|---|
| `GET /api/health` | 서버 상태 확인 |
| `POST /api/stt/transcribe` | CLOVA 전사 → 자료 기반 2차 보정 → 중간포맷 JSON |
| `POST /api/ingest-stt` | 중간포맷을 평문 에피소드로 변환 → Graphiti `/ingest-text` |
| `POST /api/ingest-doc` | 자료 텍스트 추출 → Graphiti `/ingest-text` |
| `GET /api/graph` | Graphiti `/graph` 현재 프로젝트 조회 |
| `GET /api/ask` | Graphiti `/ask` 지식 검색·답변·관련 그래프 조회 |
| `GET /api/concept/{id}` | 개념과 연결 강의 조회 |
| `GET /api/session/{id}` | 강의/자료 세션의 청크와 개념 조회 |

그래프 관련 API는 모두 `Authorization: Bearer <Supabase JWT>`가 필요하다. 적재와 조회는
`X-Project-Id` 또는 `project` 쿼리로 프로젝트 범위를 고정한다. 녹음 전용 참고자료는
`X-Meeting-Id`를 보내 같은 녹음 세션에 연결한다.

```text
자료 ── 텍스트 추출 ─┐
                    ├─ gsvx_connector ── Graphiti ── Neo4j
녹음 ─ CLOVA 전사 ──┘                         │
프론트 그래프 ◀─ /api/graph ◀────────────────┤
프론트 질문   ◀─ /api/ask   ◀────────────────┘
```

### `gsvx_connector.py`

Graphiti API 계약을 한곳에 모은 기본 커넥터다. 전사·자료 원문은 기본적으로 하나의
episode로 적재하고, Graphiti 요청 상한을 넘는 경우에만 48,000자 단위로 분할한다.
그래프 조회·질문·상세 조회도 같은 Graphiti 프로젝트로 전달한다. 예외 분할 크기와 벌크
배치 크기는 각각 `GRAPHITI_CHUNK_CHARS`, `GRAPHITI_BULK_BATCH_SIZE`로 조정할 수 있다.

## 환경변수

- Supabase Auth: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- Graphiti: 로컬 `http://127.0.0.1:8020`이 기본값. 필요할 때만 `GSVX_BASE_URL`로 변경
- STT: `CLOVA_SPEECH_INVOKE_URL`, `CLOVA_SPEECH_SECRET`

## 실행과 검증

```bash
/opt/homebrew/bin/python3.12 -m uvicorn backend.integration.api.main:app --reload --port 8000
/opt/homebrew/bin/python3.12 -m pytest backend/integration/tests -q
```
