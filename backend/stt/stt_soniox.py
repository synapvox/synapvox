import argparse
import json
import os
import time
from pathlib import Path

import requests
from langsmith import traceable

try:
    from .keyword_prompt import build_prompt, extract_keywords_from_past_meetings
except ModuleNotFoundError as exc:
    if exc.name != "kiwipiepy":
        raise

    def build_prompt(material_text: str = None, past_keywords: list = None, max_chars: int = 400) -> str:
        return None

    def extract_keywords_from_past_meetings(meeting_texts: list, top_n: int = 20) -> list:
        return []


_BASE_URL = "https://api.soniox.com/v1"
_POLL_INTERVAL_SECONDS = 2


def _tokens_to_segments(tokens: list) -> list:
    """Soniox's transcript endpoint returns word-level tokens, not segments — group
    consecutive same-speaker tokens into one segment each so downstream (stt_normalizer,
    wer.py) sees the same start/end/speaker/text segment shape as stt_clova."""
    segments = []
    for token in tokens:
        speaker = str(token.get("speaker", "UNKNOWN"))
        if segments and segments[-1]["speaker"] == speaker:
            segments[-1]["text"] += token["text"]
            segments[-1]["end"] = token["end_ms"] / 1000.0
        else:
            segments.append(
                {
                    "start": token["start_ms"] / 1000.0,
                    "end": token["end_ms"] / 1000.0,
                    "speaker": speaker,
                    "text": token["text"],
                }
            )
    for seg in segments:
        seg["text"] = seg["text"].strip()
    return segments


def _parse_transcript(data: dict, source_name: str) -> dict:
    return {"source": source_name, "segments": _tokens_to_segments(data["tokens"])}


def _upload_file(audio_path: str, headers: dict) -> str:
    with open(audio_path, "rb") as media:
        response = requests.post(f"{_BASE_URL}/files", headers=headers, files={"file": media})
    response.raise_for_status()
    return response.json()["id"]


def _create_transcription(file_id: str, headers: dict, language_hints: list, context_terms: list = None) -> str:
    body = {
        "file_id": file_id,
        "model": "stt-async-v5",
        "language_hints": language_hints,
        "enable_speaker_diarization": True,
    }
    if context_terms:
        body["context"] = {"terms": context_terms}
    response = requests.post(f"{_BASE_URL}/transcriptions", headers=headers, json=body)
    response.raise_for_status()
    return response.json()["id"]


def _wait_for_completion(transcription_id: str, headers: dict) -> None:
    while True:
        response = requests.get(f"{_BASE_URL}/transcriptions/{transcription_id}", headers=headers)
        response.raise_for_status()
        data = response.json()
        if data["status"] == "completed":
            return
        if data["status"] == "error":
            raise RuntimeError(f"Soniox transcription {transcription_id} failed: {data}")
        time.sleep(_POLL_INTERVAL_SECONDS)


@traceable(name="soniox_transcribe", run_type="tool")
def transcribe(audio_path: str, language_hints: list = None, context_terms: list = None) -> dict:
    """Transcribe + diarize in one pipeline via Soniox's async REST API (upload file →
    create transcription job → poll → fetch transcript). Async (not real-time) chosen for
    higher diarization accuracy per Soniox's own docs. Requires SONIOX_API_KEY env var."""
    api_key = os.environ["SONIOX_API_KEY"]
    headers = {"Authorization": f"Bearer {api_key}"}

    file_id = _upload_file(audio_path, headers)
    transcription_id = _create_transcription(file_id, headers, language_hints or ["ko"], context_terms)
    _wait_for_completion(transcription_id, headers)

    response = requests.get(f"{_BASE_URL}/transcriptions/{transcription_id}/transcript", headers=headers)
    response.raise_for_status()

    return _parse_transcript(response.json(), Path(audio_path).name)


def transcribe_with_materials(
    audio_path: str,
    material_text: str = None,
    past_meeting_texts: list = None,
    language_hints: list = None,
) -> dict:
    """transcribe() with context.terms resolved from current pre-meeting materials
    (preferred), merged with recurring keywords from the same project's past meetings —
    same keyword source as stt_clova.transcribe_with_materials, reused here for Soniox's
    context.terms (a plain term list) instead of CLOVA's boostings (a weighted string).
    No roster-hint fallback: context terms expect vocabulary, not a descriptive sentence."""
    past_keywords = extract_keywords_from_past_meetings(past_meeting_texts) if past_meeting_texts else None
    prompt = build_prompt(material_text, past_keywords)
    context_terms = [term.strip() for term in prompt.split(",")] if prompt else None
    return transcribe(audio_path, language_hints, context_terms)


def main():
    parser = argparse.ArgumentParser(description="Transcribe + diarize audio with Soniox")
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
