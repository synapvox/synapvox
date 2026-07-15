# integration — 통합 (API · E2E 오케스트레이션)

담당: 도원 (PM 겸). 그래프 시각화 UI는 별도 기술 스택(JS/React)이라 [`frontend/`](../../frontend/)로 분리되어 있음 — 이 폴더는 Python 백엔드만 다룬다.

## Baseline
- E2E 통합 (CLI → API 조립) — `pipeline.py`
- 실제 회의로 전체 흐름 테스트
- "좋은 정제·답변" 수용 기준 정의
- `frontend/`가 소비할 API 제공 (회의/토픽/그래프 조회 등)
- 일정·우선순위 관리

## 고도화
- 액션 아이템 → ClickUp Task 자동 생성
- 사용자 피드백 루프

## 소유 스키마
없음 — `stt/`, `chunking/`, `graphrag/`가 소유한 3개 스키마를 소비해 조립하는 통합 계층.

## 구조 — 파일별 역할

### `api/main.py` — FastAPI 서버 (프론트가 부르는 입구)

| 엔드포인트 | 입력 | 하는 일 |
|---|---|---|
| `GET /api/health` | — | 헬스체크 |
| `POST /api/stt/transcribe` | multipart: `audio` + `materials[]` (+Supabase JWT) | CLOVA 전사 → 화자 라벨링 → (자료+키 있으면) `refine_transcript` 정제 → **중간포맷 JSON 반환** |
| `POST /ingest-stt` | 중간포맷 JSON body | 검증 후 gsvx로 릴레이 (아래 표) |
| `POST /ingest-doc` | multipart: `file` 1개 | 텍스트 추출 후 gsvx로 릴레이 (아래 표) |

파일 파싱 헬퍼(`_extract_material_text` 등)와 stt 모듈 경량 로더(`_load_stt_module` —
`backend/stt/__init__.py`의 무거운 의존성을 건너뛰고 서브모듈만 로드)도 여기 있다.

### `api/auth.py` — Supabase Auth JWT 검증
`require_user` 의존성: `Authorization: Bearer <JWT>`를 Supabase JWKS로 서명 검증.
전사 엔드포인트에만 걸려 있다 (gsvx 릴레이는 gsvx 자체의 X-API-Key가 게이트).

### `pipeline.py` — 자체 GraphStore(backend/graphrag) 적재 경로
- `extract_text(path)` — pdf/pptx/docx/md/txt → 평문 (PDF는 텍스트 전용, 비전 LLM 없음)
- `chunk_transcript(im)` / `chunk_document(text, doc_id)` — 화자 전환·길이 / 문단 기준 청킹
- `ingest_files(paths, ...)` — 입력 파일들 → 청크 → `GraphStore.load_intermediate/load_chunks`
  (graphrag Baseline용. gsvx와는 **별개의 병렬 시스템** — 아래 참고)

### `gsvx_connector.py` — gsvx(Graphiti) 커넥터
- `transcript_to_text(im)` — 중간포맷 segments → `"화자: 발화"` 줄들 (순서 보존)
- `transcript_title(im)` — 세션 제목 생성 (예: `"2026-07-15 회의 전사 (M01)"`)
- `split_for_ingest(text)` — 48,000자 이내면 그대로 1파트. 초과 시에만 문단 → 줄 경계
  순으로 분할 + 파트 간 overlap (gsvx 하드 캡 50,000자/413 대응)
- `GsvxClient` — gsvx HTTP 클라이언트
  - `.ingest_text(text, title, project)` — `POST /ingest-text` 1회 호출 (원시 계약)
  - `.ingest_transcript(im, project)` — 중간포맷 → 변환·분할 → 적재
  - `.ingest_document(path, project, meeting_id)` / `.ingest_document_text(text, title, project, meeting_id)` — 자료 → 적재
    (`meeting_id` 주면 특정 회의에 스코프, 생략하면 프로젝트 전역 자료)
- `GsvxError(status_code, detail)` — gsvx 오류 (연결 실패면 `status_code=None`)
- CLI: `python -m backend.integration.gsvx_connector 파일... --project P01`

### 릴레이 엔드포인트 계약 (프론트 App.tsx가 쓰는 형태 그대로)

| | `POST /ingest-stt` | `POST /ingest-doc` |
|---|---|---|
| **바디** | 중간포맷 JSON 통째로 | multipart `file` (pdf/pptx/docx/md/txt) |
| **헤더** | `X-Project-Id`(→ gsvx project), `X-API-Key`(→ gsvx로 전달, 없으면 서버 환경변수) | 동일 + `X-Meeting-Id`(선택, → 세션 제목에 붙어 특정 회의에 딸린 자료로 스코프. 미지정 시 프로젝트 전역 자료) |
| **성공 200** | `{chunks_ingested, concepts_total, concepts_new, relations_new, sessions}` | 동일 |
| **입력 오류** | `400` — 스키마 위반 필드를 detail로 (예: `missing key: source`) | `415` — 텍스트 추출 실패/미지원 형식 |
| **gsvx 오류** | gsvx의 4xx를 그대로 전파: `401`(키), `413`(50,000자 초과), `429`(rate limit) | 동일 |
| **gsvx 다운** | `502` + `{"detail": "gsvx에 연결하지 못했습니다 (...)"}` | 동일 |

각 전사·자료는 **각각 별도의 gsvx 세션(에피소드)**으로 들어간다. 세션 간 연결은
Graphiti가 개념 층위에서 자동으로 만든다 — 같은 project(group_id) 안에서 전사와
자료가 같은 개념을 언급하면 동일 Entity 노드로 병합되어 그래프에서 이어진다.

## gsvx(Graphiti) 연결 — STT 출력이 그래프가 되기까지

그래프 뷰·AI 채팅의 엔진 본체는 별도 리포([click6067-ship-it/synapVOX](https://github.com/click6067-ship-it/synapVOX))의
gsvx(Graphiti) 백엔드다. 이 리포의 STT 산출물이 그 엔진으로 들어가는 경로를
`gsvx_connector.py`가 담당한다.

```
녹음/자료 ─▶ backend/stt (CLOVA 전사·화자분리·pdf/pptx 파싱)
              │  중간포맷 JSON (schemas/intermediate_format.schema.json)
              ▼
         gsvx_connector ──── 변환·분할 ────▶ gsvx POST /ingest-text
              │                                │ Graphiti add_episode
              │                                ├▶ OpenAI: 개념·관계 추출 (줄별 발화에서)
              │                                └▶ Neo4j: Entity/Episodic 노드 적재
              ▼
        api/main.py의 POST /ingest-stt · /ingest-doc  (프론트 App.tsx 계약 릴레이)
```

### 두 계약의 연결

**입력 — STT 중간포맷** (stt 소유, `stt_normalizer.merge()/wrap_segments()` 생성):

```json
{"source": "...", "meeting_id": "M01", "project_id": "P01",
 "date": "2026-07-15", "mode": "meeting",
 "segments": [{"id": 0, "speaker": "A", "start": 0.0, "end": 3.2, "text": "..."}]}
```

**출력 — gsvx `/ingest-text`** (텍스트가 그래프로 들어가는 유일한 입구):

```json
POST /ingest-text  (헤더: X-API-Key)
{"text": "≤50,000자 평문", "title": "세션 이름", "project": "group_id 네임스페이스"}
```

**변환 규칙** (`gsvx_connector.py`):

| 중간포맷 필드 | gsvx로 가는 곳 | 비고 |
|---|---|---|
| `segments[].speaker/text` | `text` — `"화자: 발화"` 줄들 | 화자 턴 순서 보존, Graphiti가 줄별로 개념 추출 |
| `segments[].start/end` | (버림) | gsvx가 타임스탬프를 받지 않음 |
| `date`, `mode`, `meeting_id` | `title` — 예: `"2026-07-15 회의 전사 (M01)"` | 그래프 뷰·타임라인에 표시 |
| `project_id` | `project` | Graphiti `group_id` 네임스페이스 (그래프 격리) |
| 회의자료 pdf/pptx/docx/md/txt | `text` — `pipeline.extract_text`로 평문화 | 파일명 stem이 `title` |

**크기 상한**: gsvx는 본문 50,000자 초과 시 413으로 거절한다(유출 키 비용 방어).
48,000자(수 시간 분량)까지는 **분할 없이 통째로 1회** 들어가며, 초과하는 예외적인
경우에만 문단(빈 줄) → 줄(화자 턴) 경계 순으로 자르고 파트 사이를 overlap시켜
경계 맥락 손실을 줄인다. 나뉜 파트는 `"제목 (i/n)"` 세션으로 들어간다.

### 사용 경로

1. **API 릴레이** — 프론트(App.tsx)가 쓰는 계약 그대로: `POST /ingest-stt`(중간포맷 JSON),
   `POST /ingest-doc`(multipart 파일). `X-Project-Id` 헤더 → gsvx `project`,
   `X-API-Key` 헤더는 gsvx로 전달(없으면 서버 환경변수). 응답은 프론트가 기대하는
   `{chunks_ingested, concepts_total, ...}`.
2. **모듈 직접 호출** — `GsvxClient().ingest_transcript(중간포맷)` / `.ingest_document(경로)`
3. **CLI** — `python -m backend.integration.gsvx_connector meeting.json slides.pptx --project P01`

환경변수: `GSVX_BASE_URL`(기본 `http://127.0.0.1:8020`), `GSVX_API_KEY`(기본 데모 키).

참고: `pipeline.py`의 자체 Neo4j `GraphStore`(backend/graphrag) 적재 경로는 이것과
별개의 병렬 시스템이다 — gsvx 연결은 그래프 뷰/AI 채팅용, GraphStore는 graphrag
Baseline(Topic/Decision/ActionItem 스키마)용.

## 협업 규칙
주 1회 통합 세션은 도원이 주도. E2E 실행 후 실패 지점을 스키마 계약 위반 여부로 판별한다.
