import argparse
import json
from pathlib import Path

from . import stt_clova, stt_soniox


def _clova_language_from_hints(language_hints: list) -> str:
    """CLOVA expects a single locale code like 'ko-KR'; Soniox expects a list of short
    hints like ['ko']. This project only transcribes Korean, so map 'ko'/None straight to
    CLOVA's default and pass anything else through as-is."""
    if not language_hints or language_hints[0] == "ko":
        return "ko-KR"
    return language_hints[0]


def transcribe(audio_path: str, language_hints: list = None) -> dict:
    """Soniox by default (lower WER across our golden dataset — see backend/stt/README.md
    "실제 데이터 검증 결과"), falling back to CLOVA Speech on any failure (network/API
    error, quota, etc.) so a single provider outage doesn't block the pipeline. Both
    return the same {"source", "segments": [{"start","end","speaker","text"}]} shape, so
    callers don't need to know which engine actually served the request."""
    try:
        return stt_soniox.transcribe(audio_path, language_hints)
    except Exception as exc:
        print(f"Soniox STT failed ({exc}); falling back to CLOVA")
        return stt_clova.transcribe(audio_path, _clova_language_from_hints(language_hints))


def transcribe_with_materials(
    audio_path: str,
    material_text: str = None,
    past_meeting_texts: list = None,
    language_hints: list = None,
) -> dict:
    try:
        return stt_soniox.transcribe_with_materials(audio_path, material_text, past_meeting_texts, language_hints)
    except Exception as exc:
        print(f"Soniox STT failed ({exc}); falling back to CLOVA")
        return stt_clova.transcribe_with_materials(
            audio_path, material_text, past_meeting_texts, _clova_language_from_hints(language_hints)
        )


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe + diarize audio with Soniox (default), falling back to CLOVA Speech on failure"
    )
    parser.add_argument("audio_path")
    parser.add_argument(
        "--language",
        action="append",
        dest="language_hints",
        help="Language hint (repeatable, e.g. --language ko). Default: ko",
    )
    parser.add_argument("--material", help="Path to extracted pre-meeting materials text")
    parser.add_argument(
        "--past-meeting",
        action="append",
        default=[],
        help="Path to a past meeting's transcript text (same project). Repeatable. "
        "Pass in chronological order, oldest first — recency weighting assumes this.",
    )
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    material_text = Path(args.material).read_text(encoding="utf-8") if args.material else None
    past_meeting_texts = [Path(p).read_text(encoding="utf-8") for p in args.past_meeting]

    result = transcribe_with_materials(
        args.audio_path, material_text, past_meeting_texts or None, args.language_hints
    )
    output = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
