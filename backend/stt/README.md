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

---

## 구현 (v1.0 — feat/stt-pipeline-and-intermediate-format)

기능정의서.pdf/PRD.pdf/ADR.pdf/TDD.pdf(2026-07-13, v1.0 MVP)를 정본으로 구현. **두 STT 경로 모두 존재하며
동일한 중간 포맷으로 수렴**(`merge()`/`wrap_segments()`) — chunking/graphrag는 이 스키마 하나만 알면 됨.

### 정식 경로 (ADR-005 정합 — 운영 대상)

| 파일 | 역할 |
| --- | --- |
| `ppt_extractor.py` | PPTX 슬라이드 텍스트+노트 추출 |
| `keyword_prompt.py` | 키워드 3요소 스코어링(자료 내 빈도 + 과거 빈도·최근성 + 일반 사전 대비 특이도) → STT 프롬프트 |
| `stt_clova.py` | **ADR-005 정합 경로** — CLOVA Speech 관리형 API, 전사+화자분리 한 번의 호출로 완료 |
| `stt_normalizer.py` | `wrap_segments()`(CLOVA 등 이미 화자분리된 소스 → 중간 포맷)/`validate()`. **`merge()`는 아래 로컬 검증 전용 도구**(같은 파일에 있지만 용도가 다름) |
| `refine_transcript.py` | Stage 2: OpenAI(gpt-4o) 기반 RAG 정제. `retrieve_relevant_context()`로 자체 청킹+임베딩(`text-embedding-3-small`)+코사인유사도 리트리벌 구현(아래 알려진 제약 참고 — 임시 구현) |
| `wer.py` | WER 계산(Levenshtein 기반 단어 단위) — Step 0 품질 검증용 |

### 로컬 검증 전용 (ADR-005의 의도적·임시 예외 — `synapvox_Local`에서 계속 실험, 운영 미사용)

| 파일 | 역할 |
| --- | --- |
| `stt_whisper.py` | faster-whisper 전사 (`transcribe`/`transcribe_with_materials`) — 비용 절감 목적의 로컬 검증 경로 (CLAUDE.md 참고) |
| `diarize_pyannote.py` | pyannote.audio 화자분리 — 위와 같은 이유로 로컬 검증 한정 |
| `stt_normalizer.merge()` | Whisper 세그먼트 + pyannote 화자분리 결과를 겹침 매칭으로 합침 — 위 두 파일과만 짝지어 쓰이는 글루 코드, 관리형 API 경로에선 불필요 |

운영 전환 시 이 그룹 전체(Whisper+pyannote+`merge()`)가 걷어내질 수 있는 부품 — 새 기능을 여기에 추가로 투자하지 말 것.

### 실제 데이터 검증 결과 (2026-04-02 보건복지위원회 전체회의, 15분02초, 화자 7명)

| 경로 | WER | 비고 |
| --- | --- | --- |
| Whisper 베이스라인 | 54.69% | 반복 루프(hallucination) 버그 있음, "추가경정예산안"→"추가경영예산안" 오인식 |
| Whisper + roster-hint 키워드 주입 | 57.01% | 메타데이터만으론 실제 오인식 단어를 못 잡아 오히려 소폭 악화 — "메타데이터 ≠ 키워드 RAG"의 근거 |
| **CLOVA Speech (ADR-005 경로)** | **40.66%** | 전문용어 정확 인식, 반복 루프 없음, 화자 7명 정확 검출 — ADR-005가 관리형 API를 택한 근거가 실측으로 확인됨 |
| CLOVA + `refine_transcript.py` (사전자료 없이 정제만) | 39.01% | 사전자료 없이도 문맥 다듬기만으로 소폭 개선 |
| CLOVA + `boostings` 도메인 키워드(2026-07-14) | 41.49% | 파라미터 자체는 `/recognizer/upload`에서 정상 동작 확인(에러 없음) — 다만 boost한 단어("추가경정예산안")를 CLOVA가 이미 boosting 없이도 맞히고 있어서 개선 효과는 못 봄(오히려 소폭 상승, 호출 간 노이즈 범위). "동작 확인"과 "효과 입증"은 별개 — 아래 알려진 제약 참고 |
| `retrieve_relevant_context()` 리트리벌 정확성(2026-07-14) | — (WER 아님) | 관련/무관 문단을 섞은 합성 자료로 검증 — 관련 있는 문단은 남기고 무관한 문단은 정확히 걸러냄(top_k=1). WER 비교가 아니라 리트리벌 자체의 정확성 확인 목적 |

### 알려진 제약 (다음 사람이 이어받을 때 참고)

- **실제 회의자료(PPT/PDF) 기반 키워드 주입·정제는 미검증** — 위 결과는 전부 국회 회의록(자료 없음) 기준. `build_prompt(material_text=...)`/`refine_transcript(material_text=...)`가 실제로 도메인 용어 정확도를 끌어올리는지는 자료 있는 케이스로 별도 검증 필요(PRD §9 수용 기준의 일부가 여기 해당).
- **`stt_clova.py`의 `boostings` 연동, 효과 미입증** — `transcribe_with_materials()`가 `keyword_prompt.build_prompt()` 결과를 CLOVA `boostings` 파라미터에 주입하도록 구현됨(NCP 문서는 `/recognizer/object-storage`에서만 이 필드를 명시하지만, 우리가 쓰는 `/recognizer/upload`도 라이브 호출로 정상 수락 확인). 다만 실제 WER 개선 효과는 아직 못 봤음 — CLOVA가 현재도 오인식하는 실제 도메인 용어가 있는 테스트 케이스가 있어야 제대로 검증 가능(위 "실제 회의자료 미검증" 항목과 같은 근본 원인).
- **긴 오디오(1시간 이상) 미검증** — 위 수치는 15분 분량 기준. 같은 전체회의의 1부(1시간46분50초)는 아직 CLOVA로 실행 안 함.
- **`retrieve_relevant_context()`는 임시 구현, 최종 통합 지점 아님** — 용하의 벡터 저장소(pgvector/Chroma)가 아직 준비 안 돼서, 우리 stage 안에서 자체적으로 청킹+OpenAI 임베딩+코사인유사도로 구현해 "리트리벌 개념 자체가 작동하는지"만 검증한 것(사용자 확인 완료, 2026-07-14). 실제 통합 지점은 `backend/graphrag/vector_store.py`의 `VectorStore.add_chunks()`(저장)/`query()`(조회) — 용하가 실제 임베딩 함수(현재는 `hashing_embed` 스텁)를 붙이면, `retrieve_relevant_context()` 내부만 그 호출로 교체하면 됨. `refine_transcript()`/`build_refinement_prompt()` 시그니처는 그대로.
- **pyannote 직접 구현은 ADR-005 위반이지만 의도적 예외** — 비용 때문에 로컬 검증 단계에서만 유지, 운영 전환 시 CLOVA(또는 동급 관리형 API)로 전환 예정.
- 로컬 스트리밍(마이크 실시간 캡처)은 미구현 — 현재 아키텍처는 녹음 완료 파일 입력을 전제(TDD 6단계 파이프라인 참고), Baseline의 "스트리밍 전사"는 배치 파일을 세그먼트 단위로 순차 출력하는 것을 가리킴. 실시간 캡처가 필요하면 스코프 재확인 필요.
