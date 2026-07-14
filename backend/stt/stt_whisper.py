import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel

from .keyword_prompt import extract_keywords_from_past_meetings, resolve_prompt


def transcribe(audio_path: str, model_size: str = "large-v3", initial_prompt: str = None) -> dict:
    model = WhisperModel(model_size)
    segments, _ = model.transcribe(audio_path, initial_prompt=initial_prompt)

    return {
        "source": Path(audio_path).name,
        "segments": [
            {"start": s.start, "end": s.end, "text": s.text.strip()}
            for s in segments
        ],
    }


def transcribe_with_materials(
    audio_path: str,
    material_text: str = None,
    meta: dict = None,
    past_meeting_texts: list = None,
    model_size: str = "large-v3",
) -> dict:
    """transcribe() with the prompt resolved from: current pre-meeting materials' keywords
    (preferred) + recurring keywords from the same project's past meetings, if given, else
    a roster hint (fallback, only if meta is given). See keyword_prompt.resolve_prompt."""
    past_keywords = extract_keywords_from_past_meetings(past_meeting_texts) if past_meeting_texts else None
    prompt = resolve_prompt(material_text, meta, past_keywords)
    return transcribe(audio_path, model_size, prompt)


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper")
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="large-v3", help="faster-whisper model size")
    parser.add_argument("--prompt", help="Raw initial_prompt string — overrides --material/--meta")
    parser.add_argument("--material", help="Path to extracted pre-meeting materials text")
    parser.add_argument("--meta", help="Path to meta.json — roster-hint fallback when no --material given")
    parser.add_argument(
        "--past-meeting",
        action="append",
        default=[],
        help="Path to a past meeting's transcript text (same project). Repeatable. "
        "Pass in chronological order, oldest first — recency weighting assumes this.",
    )
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    if args.prompt:
        prompt = args.prompt
    else:
        material_text = Path(args.material).read_text(encoding="utf-8") if args.material else None
        meta = json.loads(Path(args.meta).read_text(encoding="utf-8")) if args.meta else None
        past_keywords = None
        if args.past_meeting:
            past_texts = [Path(p).read_text(encoding="utf-8") for p in args.past_meeting]
            past_keywords = extract_keywords_from_past_meetings(past_texts)
        prompt = resolve_prompt(material_text, meta, past_keywords)

    result = transcribe(args.audio_path, args.model, prompt)
    output = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
