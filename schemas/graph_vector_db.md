# Graph / Vector DB 스키마 (draft v0.1)

출처: "회의 지식 파이프라인 MVP 구현 계획" 3-3절. 첫 주에 4인 확정 필요 — 확정 전까지 draft.

## Vector DB
청크 임베딩 + 메타데이터. MVP는 pgvector(또는 Chroma). 메타데이터 필터: `project_id`, `meeting_id`, `source_type`.

## Graph DB (Neo4j) — 노드

| 노드 | 주요 속성 | 비고 |
| --- | --- | --- |
| Project | project_id, name | 프로젝트 단위 루트 |
| Meeting | meeting_id, date, title, summary | 회의 1건 |
| Chunk | chunk_id, source_type, raw_span, timestamps, vector_ref | Vector DB와 chunk_id로 교차 참조 |
| Document | doc_id, path, type(pdf/pptx/minutes) | 회의자료·과거 회의록 |
| Topic | topic_id, name, aliases | 회의를 가로지르는 주제 (canonical ID) |
| Decision | decision_id, statement, date | 결정 사항 |
| ActionItem | item_id, task, assignee, due | 액션 아이템 |

## Graph DB (Neo4j) — 엣지

| 엣지 | 방향 | 의미 |
| --- | --- | --- |
| HAS_MEETING | Project → Meeting | 프로젝트 귀속 |
| FOLLOWS | Meeting → Meeting | 시간 순서 (시간별 정리의 축) |
| HAS_CHUNK | Meeting/Document → Chunk | 청크 귀속 |
| USES_DOCUMENT | Meeting → Document | 회의-자료 연결 |
| DISCUSSES | Meeting/Chunk → Topic | 주제 연결 (맥락별 정리의 축) |
| DECIDED_IN / RAISED_IN | Decision/ActionItem → Meeting | 산출물 출처 |
| SUPERSEDES | Decision → Decision | 결정 번복 이력 |
| RELATES_TO | Topic → Topic | 주제 간 연관 |

적재 시점부터 이 스키마만 사용한다 (재설계 없이 고도화에서 확장).
