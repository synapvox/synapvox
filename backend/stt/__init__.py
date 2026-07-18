"""stt — ① STT 파이프라인 (담당 A: 현우).

integration 계층(D) 및 chunking(B)이 소비하는 공개 API:

    from backend.stt import extract_pptx, extract_pdf, resolve_prompt, merge, wrap_segments, validate
    from backend.stt.stt import transcribe as managed_transcribe
    from backend.stt.stt_whisper import transcribe_with_materials
    from backend.stt.diarize_pyannote import diarize
    from backend.stt.refine_transcript import refine_transcript

    material = extract_pptx("slides.pptx")  # 또는 extract_pdf("자료.pdf") — 둘 다 임베딩 이미지를
                                             # GPT-4o Vision으로 설명해 텍스트에 인라인 포함(비용 발생,
                                             # describe_images=False로 끌 수 있음)

    # 경로 A — 관리형 API (ADR-005 정합, 운영 권장): 전사+화자분리 한 번에.
    # stt.transcribe()는 Soniox를 기본으로 호출하고 실패 시 CLOVA로 자동 폴백한다(둘 다 리턴 shape
    # 동일). 엔진을 고정해야 하면 backend.stt.stt_clova / backend.stt.stt_soniox를 직접 호출.
    raw = managed_transcribe("meeting.m4a")
    intermediate = wrap_segments(raw["segments"], source=raw["source"],
                                  date="2026-07-13", project_id="P01", meeting_id="M07")

    # 경로 B — 로컬 검증용(Whisper+pyannote, ADR-005의 의도적·임시 예외 — CLAUDE.md 참고)
    whisper = transcribe_with_materials("meeting.m4a", material_text=material_text)
    diarization = diarize("meeting.m4a")
    intermediate = merge(whisper["segments"], diarization["turns"], source=whisper["source"],
                          date="2026-07-13", project_id="P01", meeting_id="M07")

    validate(intermediate)  # 스키마 계약 검증 (schemas/intermediate_format.schema.json)

    # Stage 2 — RAG 기반 정제 (OpenAI, pgvector 생기기 전까지는 컨텍스트 전량 투입)
    refined = refine_transcript(intermediate, material_text=material_text)

세 STT 경로(CLOVA / Soniox / Whisper+pyannote) 모두 최종적으로 이 모듈의 `merge()`/`wrap_segments()`를
거쳐 동일한 중간 포맷 JSON(`schemas/intermediate_format.schema.json`)으로 수렴한다 — chunking/graphrag는
이 스키마 하나만 알면 되고, STT 내부에서 어떤 엔진을 쓰는지는 몰라도 된다. CLOVA와 Soniox는 리턴 shape이
동일해 `stt.py`에서 안전하게 스위칭된다(골든 데이터셋 9개 비교 결과는 README.md 참고).
"""

# NOTE: stt_whisper.py(faster-whisper) / diarize_pyannote.py(pyannote.audio) /
# stt_clova.py(requests) / refine_transcript.py(openai) each pull in a heavy or
# credential-gated dependency at import time — importing this package must not force
# all of them to load just to reach a lightweight function like extract_pptx. Only the
# dependency-light modules are re-exported here; import the others directly from their
# submodule (see usage example above).
from .ppt_extractor import extract_pptx
from .pdf_extractor import extract_pdf
from .keyword_prompt import (
    build_prompt,
    build_roster_hint,
    extract_keywords,
    extract_keywords_from_past_meetings,
    resolve_prompt,
)
from .stt_normalizer import merge, validate, wrap_segments
from .wer import word_error_rate
from .quality_report import get_quality_rows
from .health import check_stt_health

__all__ = [
    "extract_pptx", "extract_pdf",
    "build_prompt", "build_roster_hint", "extract_keywords",
    "extract_keywords_from_past_meetings", "resolve_prompt",
    "merge", "validate", "wrap_segments",
    "word_error_rate",
    "get_quality_rows", "check_stt_health",
]
