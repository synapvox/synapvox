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
- `api/` — 외부(및 `frontend/`)에 노출하는 API 서버
- `pipeline.py` — E2E 오케스트레이션 (아직 미작성)

## 협업 규칙
주 1회 통합 세션은 도원이 주도. E2E 실행 후 실패 지점을 스키마 계약 위반 여부로 판별한다.
