import argparse
import json
import os
from pathlib import Path

import requests

try:
    from .keyword_prompt import build_prompt, extract_keywords_from_past_meetings
except ModuleNotFoundError as exc:
    if exc.name != "kiwipiepy":
        raise

    def build_prompt(material_text: str = None, past_keywords: list = None, max_chars: int = 400) -> str:
        return None

    def extract_keywords_from_past_meetings(meeting_texts: list, top_n: int = 20) -> list:
        return []


def _parse_response(data: dict, source_name: str) -> dict:
    return {
        "source": source_name,
        "segments": [
            {
                "start": seg["start"] / 1000.0,
                "end": seg["end"] / 1000.0,
                "speaker": seg.get("speaker", {}).get("label", "UNKNOWN"),
                "text": seg["text"].strip(),
            }
            for seg in data["segments"]
        ],
    }


def _build_params(language: str, boost_keywords: str = None, boost_weight: str = "5") -> dict:
    """boost_keywords is a comma-separated term string (see keyword_prompt.build_prompt) injected
    via CLOVA's `boostings` param. NCP docs only document `boostings` for /recognizer/object-storage
    (words: str, weight: str, max 1000 entries, Korean/English only), not /recognizer/upload (its
    docs page 404s) — but a live call confirmed /recognizer/upload accepts the param without error.
    Effect on WER is still unproven: a live test boosting a term CLOVA's baseline already got right
    showed no improvement (40.66%→41.49%, within call-to-call noise) — re-test once a real
    misrecognition case exists, don't read this as "boosting doesn't help"."""
    params = {
        "language": language,
        "completion": "sync",
        "diarization": {"enable": True},
        "wordAlignment": True,
        "fullText": True,
    }
    if boost_keywords:
        params["boostings"] = [{"words": boost_keywords, "weight": boost_weight}]
    return params


def transcribe(audio_path: str, language: str = "ko-KR", boost_keywords: str = None, boost_weight: str = "5") -> dict:
    """Transcribe + diarize in one call via CLOVA Speech (managed API, built-in speaker
    diarization) per ADR-005. Requires CLOVA_SPEECH_INVOKE_URL (per-domain URL from the
    NCP console) and CLOVA_SPEECH_SECRET (X-CLOVASPEECH-API-KEY) as env vars."""
    invoke_url = os.environ["CLOVA_SPEECH_INVOKE_URL"]
    secret = os.environ["CLOVA_SPEECH_SECRET"]

    params = _build_params(language, boost_keywords, boost_weight)

    with open(audio_path, "rb") as media:
        response = requests.post(
            f"{invoke_url}/recognizer/upload",
            headers={"X-CLOVASPEECH-API-KEY": secret},
            files={"media": media},
            data={"params": json.dumps(params)},
        )
    response.raise_for_status()

    return _parse_response(response.json(), Path(audio_path).name)


def transcribe_with_materials(
    audio_path: str,
    material_text: str = None,
    past_meeting_texts: list = None,
    language: str = "ko-KR",
    boost_weight: str = "5",
) -> dict:
    """transcribe() with boost_keywords resolved from current pre-meeting materials (preferred),
    merged with recurring keywords from the same project's past meetings — same keyword source
    as stt_whisper.transcribe_with_materials, reused here for CLOVA's boostings param instead of
    Whisper's initial_prompt. No roster-hint fallback: boostings expects vocabulary terms, not a
    descriptive sentence, so boosting is skipped entirely when there's nothing but meta.json."""
    past_keywords = extract_keywords_from_past_meetings(past_meeting_texts) if past_meeting_texts else None
    boost_keywords = build_prompt(material_text, past_keywords)
    return transcribe(audio_path, language, boost_keywords, boost_weight)


def main():
    parser = argparse.ArgumentParser(description="Transcribe + diarize audio with CLOVA Speech")
    parser.add_argument("audio_path")
    parser.add_argument("--language", default="ko-KR")
    parser.add_argument("--material", help="Path to extracted pre-meeting materials text")
    parser.add_argument(
        "--past-meeting",
        action="append",
        default=[],
        help="Path to a past meeting's transcript text (same project). Repeatable. "
        "Pass in chronological order, oldest first — recency weighting assumes this.",
    )
    parser.add_argument("--boost-weight", default="5", help="CLOVA boostings weight (default: 5)")
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    material_text = Path(args.material).read_text(encoding="utf-8") if args.material else None
    past_meeting_texts = [Path(p).read_text(encoding="utf-8") for p in args.past_meeting]

    result = transcribe_with_materials(
        args.audio_path, material_text, past_meeting_texts or None, args.language, args.boost_weight
    )
    output = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
