# stt — ① STT 파이프라인

담당: 현우

## Baseline
- Whisper(faster-whisper) 연동, 스트리밍 전사
- 회의자료 키워드 추출 + `initial_prompt` 주입 (1-pass)
- 회의자료·과거 회의록 RAG 기반 정제 (2-pass)
- Step 0 품질 검증 (키워드 주입 개선율 측정)
- 중간 포맷 JSON 변환기 → [`schemas/intermediate_format.schema.json`](../../schemas/intermediate_format.schema.json) 출력

## 고도화
- 실시간 스트리밍 정제, hotword 실시간 갱신
- 화자 실명 매핑, 화상회의 자동 녹화 연동

## 소유 스키마
중간 포맷 JSON — 이 모듈이 출력하는 계약. 변경 시 B/C/D에 공지 후 반영.
