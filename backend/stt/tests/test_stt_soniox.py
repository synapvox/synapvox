import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.stt.stt_soniox import _parse_transcript, _tokens_to_segments


def test_tokens_to_segments_groups_consecutive_same_speaker_tokens():
    tokens = [
        {"text": "안녕", "speaker": "1", "start_ms": 754200, "end_ms": 754600},
        {"text": "하세요", "speaker": "1", "start_ms": 754600, "end_ms": 755000},
        {"text": "반갑습니다", "speaker": "2", "start_ms": 762000, "end_ms": 765000},
    ]

    segments = _tokens_to_segments(tokens)

    assert segments == [
        {"start": 754.2, "end": 755.0, "speaker": "1", "text": "안녕하세요"},
        {"start": 762.0, "end": 765.0, "speaker": "2", "text": "반갑습니다"},
    ]


def test_tokens_to_segments_defaults_speaker_when_missing():
    tokens = [{"text": "화자분리 실패", "start_ms": 0, "end_ms": 1000}]

    segments = _tokens_to_segments(tokens)

    assert segments[0]["speaker"] == "UNKNOWN"


def test_parse_transcript_wraps_segments_with_source_name():
    data = {"tokens": [{"text": "안녕", "speaker": "1", "start_ms": 0, "end_ms": 500}]}

    result = _parse_transcript(data, "meeting.m4a")

    assert result["source"] == "meeting.m4a"
    assert result["segments"] == [{"start": 0.0, "end": 0.5, "speaker": "1", "text": "안녕"}]
