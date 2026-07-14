import argparse
import json
from pathlib import Path


def _relabel(raw_speaker: str, speaker_labels: dict) -> str:
    if raw_speaker not in speaker_labels:
        speaker_labels[raw_speaker] = chr(ord("A") + len(speaker_labels))
    return speaker_labels[raw_speaker]


def _assign_speaker(seg: dict, turns: list, speaker_labels: dict) -> str:
    def overlap(turn):
        return max(0.0, min(seg["end"], turn["end"]) - max(seg["start"], turn["start"]))

    best_turn = max(turns, key=overlap, default=None)
    if best_turn is None or overlap(best_turn) <= 0:
        return "UNKNOWN"

    return _relabel(best_turn["speaker"], speaker_labels)


def merge(
    whisper_segments: list,
    diarization_turns: list,
    source: str,
    date: str,
    project_id: str,
    meeting_id: str,
    mode: str = "meeting",
) -> dict:
    speaker_labels = {}
    segments = []
    for seg in whisper_segments:
        text = seg["text"].strip()
        if not text:
            continue
        segments.append({
            "id": len(segments),
            "speaker": _assign_speaker(seg, diarization_turns, speaker_labels),
            "start": seg["start"],
            "end": seg["end"],
            "text": text,
        })

    return {
        "source": source,
        "meeting_id": meeting_id,
        "project_id": project_id,
        "date": date,
        "mode": mode,
        "segments": segments,
    }


def wrap_segments(
    raw_segments: list,
    source: str,
    date: str,
    project_id: str,
    meeting_id: str,
    mode: str = "meeting",
) -> dict:
    """Like merge(), but for a source that already assigns a speaker per segment
    (e.g. a managed STT API with built-in diarization, such as CLOVA Speech) —
    no overlap-matching against a separate diarization pass needed."""
    speaker_labels = {}
    segments = []
    for seg in raw_segments:
        text = seg["text"].strip()
        if not text:
            continue
        segments.append({
            "id": len(segments),
            "speaker": _relabel(seg.get("speaker", "UNKNOWN"), speaker_labels),
            "start": seg["start"],
            "end": seg["end"],
            "text": text,
        })

    return {
        "source": source,
        "meeting_id": meeting_id,
        "project_id": project_id,
        "date": date,
        "mode": mode,
        "segments": segments,
    }


def validate(data: dict) -> None:
    for key in ("source", "meeting_id", "project_id", "date", "mode", "segments"):
        if key not in data:
            raise ValueError(f"missing key: {key}")

    for i, seg in enumerate(data["segments"]):
        if seg["id"] != i:
            raise ValueError(f"segment id must be sequential starting at 0, got {seg['id']} at index {i}")
        if seg["start"] >= seg["end"]:
            raise ValueError(f"segment {seg['id']}: start must be before end")
        if not seg["text"]:
            raise ValueError(f"segment {seg['id']}: empty text")


def main():
    parser = argparse.ArgumentParser(
        description="Merge Whisper segments and pyannote diarization turns into the 중간 포맷 JSON schema"
    )
    parser.add_argument("whisper_json", help="Output of backend.stt.stt_whisper")
    parser.add_argument("diarization_json", help="Output of backend.stt.diarize_pyannote")
    parser.add_argument("--date", required=True, help="Recording date, e.g. 2026-07-13")
    parser.add_argument("--project-id", required=True, help="Project this recording belongs to, e.g. P01")
    parser.add_argument("--meeting-id", required=True, help="Meeting id within the project, e.g. M07")
    parser.add_argument("--mode", default="meeting", help="meeting | lecture (default: meeting)")
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    whisper_data = json.loads(Path(args.whisper_json).read_text(encoding="utf-8"))
    diarization_data = json.loads(Path(args.diarization_json).read_text(encoding="utf-8"))

    result = merge(
        whisper_data["segments"],
        diarization_data["turns"],
        source=whisper_data["source"],
        date=args.date,
        project_id=args.project_id,
        meeting_id=args.meeting_id,
        mode=args.mode,
    )
    validate(result)

    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
