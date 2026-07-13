# chunking — ② 청킹 · LLM 추출 / 품질

담당: 도윤

## Baseline
- 전사문·회의자료 청킹 로직 (화자/주제 전환 기준, 슬라이드/섹션 기준)
- 적재 시 Topic/Decision/ActionItem 추출 프롬프트 + JSON 스키마 검증·재시도 루프
- Graph RAG+ 답변 생성 프롬프트
- 평가용 정답셋 (회의 3~5건 라벨링)

## 고도화
- Topic 일관성 (엔티티 해소) 개선
- SUPERSEDES · Thread 관계 판정 프롬프트
- 모델/프롬프트 A/B 평가 체계

## 소유 스키마
LLM 추출 JSON — 이 모듈이 출력하는 계약. → [`schemas/llm_extraction.schema.json`](../../schemas/llm_extraction.schema.json)
