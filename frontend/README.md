# frontend — 회의 간 관계 그래프 시각화 UI

담당: 도원

문서상 "Neo4j Bloom 또는 vis.js/Cytoscape.js 임베드" — JS 라이브러리 사용이 전제라 Python 백엔드(`backend/`)와 분리된 별도 앱으로 둔다.

## Baseline
- `backend/integration`의 API에서 회의/토픽/그래프 서브그래프를 받아 렌더링
- 회의 노드 클릭 → 요약·참여 Topic·결정 표시
- Topic 클릭 → 관련 회의 타임라인 표시

## 고도화
- 인터랙티브 그래프 탐색 UX
- 북마크 클릭 시 오디오 구간 재생 연동

## 구조 (초안 — 프레임워크/빌드 도구 미정)
- `src/graph-view/` — 그래프 렌더링 컴포넌트 (vis.js/Cytoscape.js)
- `public/`

React/Vite 등 구체적 스택은 아직 미정 — 정하는 대로 `package.json` 추가.
