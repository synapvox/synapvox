# SynapVox

강의 지식 파이프라인 — 녹음/자료 → 2-pass STT → Graphiti 지식 그래프 → 질의응답.

기획 배경과 상세 설계는 ClickUp Team Docs("회의 지식 파이프라인 MVP 구현 계획") 참고.

## 구조 (모노레포)

기술 스택 기준 `backend/`(Python) · `frontend/`(JS, 그래프 시각화)로 나누고, `backend/` 안은 파이프라인 4단계 + 통합 축으로 나눈다. 담당자 간 계약은 [`schemas/`](schemas/)의 3개 스키마이며, 이 스키마가 모듈 간 유일한 인터페이스다.

| 모듈 | 단계 | 담당 | 소유 스키마 |
| --- | --- | --- | --- |
| [`backend/stt/`](backend/stt/) | ① STT (2-pass) | 현우 | 중간 포맷 JSON |
| [`backend/chunking/`](backend/chunking/) | ② 청킹 + LLM 추출 | 도윤 | LLM 추출 JSON |
| [`backend/graphrag/`](backend/graphrag/) | ③④ Vector/Graph DB + 검색 | 용하 | Graph/Vector DB 스키마 |
| [`backend/integration/`](backend/integration/) | 통합 API/E2E (PM) | 도원 | (없음 — 통합) |
| [`frontend/`](frontend/) | 그래프 시각화 UI (PM) | 도원 | (없음 — `backend/integration` API 소비) |

## 그 외 디렉터리

- `schemas/` — 3개 계약 스키마 원본 (JSON Schema / 문서). 언어 무관이라 최상위에 둠. 변경 시 소유자가 제안하고 영향받는 담당자 합의 후 반영.
- `docs/` — 로컬 문서. 정본은 ClickUp Team Docs, 여기는 참고용 백업/링크만 둔다.
- `scripts/` — 로컬 인프라 실행 스크립트 (DB 기동 등).
- `data/` — 샘플 회의 녹음·자료. Git에는 커밋하지 않는다.

## 시작하기

각 모듈의 `README.md`에 해당 담당자의 Baseline 작업 범위가 있다. 첫 주 목표는 `schemas/` 3종 확정.
