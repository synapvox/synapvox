import argparse
import json
import os
from pathlib import Path

import requests


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


def transcribe(audio_path: str, language: str = "ko-KR") -> dict:
    """Transcribe + diarize in one call via CLOVA Speech (managed API, built-in speaker
    diarization) per ADR-005. Requires CLOVA_SPEECH_INVOKE_URL (per-domain URL from the
    NCP console) and CLOVA_SPEECH_SECRET (X-CLOVASPEECH-API-KEY) as env vars."""
    invoke_url = os.environ["CLOVA_SPEECH_INVOKE_URL"]
    secret = os.environ["CLOVA_SPEECH_SECRET"]

    params = {
        "language": language,
        "completion": "sync",
        "diarization": {"enable": True},
        "wordAlignment": True,
        "fullText": True,
    }

    with open(audio_path, "rb") as media:
        response = requests.post(
            f"{invoke_url}/recognizer/upload",
            headers={"X-CLOVASPEECH-API-KEY": secret},
            files={"media": media},
            data={"params": json.dumps(params)},
        )
    response.raise_for_status()

    return _parse_response(response.json(), Path(audio_path).name)


def main():
    parser = argparse.ArgumentParser(description="Transcribe + diarize audio with CLOVA Speech")
    parser.add_argument("audio_path")
    parser.add_argument("--language", default="ko-KR")
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    result = transcribe(args.audio_path, args.language)
    output = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
