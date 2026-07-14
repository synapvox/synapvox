# schemas — 모듈 간 계약

4인 병렬 개발을 가능케 하는 유일한 인터페이스. 첫 주에 4인이 함께 확정하고, 이후 변경은 소유자가 제안 → 영향받는 담당자 합의 → 버전 명시 후 반영한다.

| 파일 | 내용 | 소유 |
| --- | --- | --- |
| `intermediate_format.schema.json` | STT 1-pass/2-pass 공통 중간 포맷 (source/mode/segments[].text) — **v1.0 확정** | stt (현우) |
| `llm_extraction.schema.json` | 적재 시 Topic/Decision/ActionItem 추출 결과 | chunking (도윤) |
| `graph_vector_db.md` | Graph DB 노드/엣지 정의 + Vector DB 메타데이터 필드 | graphrag (용하) |

`intermediate_format.schema.json`은 기능정의서.pdf §3-2 / TDD.pdf §3-1(2026-07-13, v1.0 MVP) 기준으로 확정됨(소유자: 현우) —
`backend/stt/`의 `merge()`/`wrap_segments()`가 이 형태로 실제 데이터 검증까지 마침(자세한 내용은 `backend/stt/README.md`).
나머지 2개 파일은 여전히 자리표시자(placeholder) 상태 — 각 소유자가 확정 전까지 손대지 않음.
