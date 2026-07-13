# schemas — 모듈 간 계약

4인 병렬 개발을 가능케 하는 유일한 인터페이스. 첫 주에 4인이 함께 확정하고, 이후 변경은 소유자가 제안 → 영향받는 담당자 합의 → 버전 명시 후 반영한다.

| 파일 | 내용 | 소유 |
| --- | --- | --- |
| `intermediate_format.schema.json` | STT 1-pass/2-pass 공통 중간 포맷 (segments, corrections 등) | stt (현우) |
| `llm_extraction.schema.json` | 적재 시 Topic/Decision/ActionItem 추출 결과 | chunking (도윤) |
| `graph_vector_db.md` | Graph DB 노드/엣지 정의 + Vector DB 메타데이터 필드 | graphrag (용하) |

아직 미확정 — 각 파일은 자리표시자(placeholder) 상태.
