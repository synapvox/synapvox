import argparse
import json
import os
from pathlib import Path

from pyannote.audio import Pipeline


def diarize(audio_path: str) -> dict:
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=os.environ["HUGGINGFACE_TOKEN"],
    )
    output = pipeline(audio_path)

    turns = [
        {"start": turn.start, "end": turn.end, "speaker": speaker}
        for turn, _, speaker in output.exclusive_speaker_diarization.itertracks(yield_label=True)
    ]

    return {"source": Path(audio_path).name, "turns": turns}


def main():
    parser = argparse.ArgumentParser(description="Speaker-diarize audio with pyannote.audio")
    parser.add_argument("audio_path")
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    result = diarize(args.audio_path)
    output = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
