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

## 구조
- `api/` — 외부(및 `frontend/`)에 노출하는 API 서버 (STT 전사 + gsvx 릴레이)
- `pipeline.py` — E2E 오케스트레이션 (입력 파일 → 청킹 → 자체 Neo4j `GraphStore` 적재)
- `gsvx_connector.py` — STT 산출물·회의자료 → gsvx(Graphiti) 그래프 엔진 커넥터

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
