import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

import pytest

from backend.stt.stt_normalizer import merge, validate, wrap_segments


def test_merge_assigns_speaker_by_max_overlap():
    whisper_segments = [
        {"start": 0.0, "end": 2.0, "text": "안녕하세요"},
        {"start": 2.5, "end": 5.0, "text": "네 반갑습니다"},
        {"start": 5.0, "end": 8.0, "text": "오늘 안건은..."},
    ]
    diarization_turns = [
        {"start": 0.0, "end": 2.2, "speaker": "SPEAKER_01"},
        {"start": 2.2, "end": 6.0, "speaker": "SPEAKER_00"},
        {"start": 6.0, "end": 9.0, "speaker": "SPEAKER_01"},
    ]

    result = merge(
        whisper_segments, diarization_turns,
        source="meeting.m4a", date="2026-07-13", project_id="P01", meeting_id="M07",
    )

    assert result["source"] == "meeting.m4a"
    assert result["date"] == "2026-07-13"
    assert result["project_id"] == "P01"
    assert result["meeting_id"] == "M07"
    assert result["mode"] == "meeting"
    assert [s["speaker"] for s in result["segments"]] == ["A", "B", "A"]
    assert [s["id"] for s in result["segments"]] == [0, 1, 2]
    assert result["segments"][0]["text"] == "안녕하세요"


def test_merge_drops_empty_text_segments():
    whisper_segments = [
        {"start": 0.0, "end": 1.0, "text": "  "},
        {"start": 1.0, "end": 2.0, "text": "실제 발화"},
    ]
    diarization_turns = [{"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"}]

    result = merge(
        whisper_segments, diarization_turns,
        source="x.m4a", date="2026-07-13", project_id="P01", meeting_id="M07",
    )

    assert len(result["segments"]) == 1
    assert result["segments"][0]["id"] == 0
    assert result["segments"][0]["text"] == "실제 발화"


def test_merge_handles_no_diarization_turns():
    whisper_segments = [{"start": 0.0, "end": 1.0, "text": "화자분리 실패 상황"}]

    result = merge(
        whisper_segments, [],
        source="x.m4a", date="2026-07-13", project_id="P01", meeting_id="M07",
    )

    assert result["segments"][0]["speaker"] == "UNKNOWN"


def test_merge_mode_defaults_to_meeting_but_is_overridable():
    result = merge(
        [{"start": 0.0, "end": 1.0, "text": "강의 시작"}], [],
        source="x.m4a", date="2026-07-13", project_id="P01", meeting_id="M07", mode="lecture",
    )

    assert result["mode"] == "lecture"


def test_validate_passes_on_well_formed_data():
    data = merge(
        [{"start": 0.0, "end": 1.0, "text": "안녕"}],
        [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00"}],
        source="x.m4a", date="2026-07-13", project_id="P01", meeting_id="M07",
    )
    validate(data)


def test_validate_rejects_missing_project_id():
    data = {
        "source": "x.m4a", "meeting_id": "M07", "date": "2026-07-13", "mode": "meeting",
        "segments": [{"id": 0, "speaker": "A", "start": 0.0, "end": 1.0, "text": "a"}],
    }
    with pytest.raises(ValueError, match="project_id"):
        validate(data)


def test_validate_rejects_non_sequential_ids():
    data = {
        "source": "x.m4a", "meeting_id": "M07", "project_id": "P01", "date": "2026-07-13", "mode": "meeting",
        "segments": [
            {"id": 0, "speaker": "A", "start": 0.0, "end": 1.0, "text": "a"},
            {"id": 2, "speaker": "A", "start": 1.0, "end": 2.0, "text": "b"},
        ],
    }
    with pytest.raises(ValueError):
        validate(data)


def test_validate_rejects_start_after_end():
    data = {
        "source": "x.m4a", "meeting_id": "M07", "project_id": "P01", "date": "2026-07-13", "mode": "meeting",
        "segments": [{"id": 0, "speaker": "A", "start": 5.0, "end": 1.0, "text": "a"}],
    }
    with pytest.raises(ValueError):
        validate(data)


def test_wrap_segments_relabels_speakers_in_first_seen_order():
    raw_segments = [
        {"start": 0.0, "end": 2.0, "speaker": "1", "text": "안녕하세요"},
        {"start": 2.0, "end": 4.0, "speaker": "2", "text": "네 반갑습니다"},
        {"start": 4.0, "end": 6.0, "speaker": "1", "text": "회의를 시작하겠습니다"},
    ]

    result = wrap_segments(raw_segments, source="x.m4a", date="2026-07-13", project_id="P01", meeting_id="M07")

    assert [s["speaker"] for s in result["segments"]] == ["A", "B", "A"]
    assert [s["id"] for s in result["segments"]] == [0, 1, 2]
    assert result["mode"] == "meeting"


def test_wrap_segments_drops_empty_text():
    raw_segments = [
        {"start": 0.0, "end": 1.0, "speaker": "1", "text": "  "},
        {"start": 1.0, "end": 2.0, "speaker": "1", "text": "실제 발화"},
    ]

    result = wrap_segments(raw_segments, source="x.m4a", date="2026-07-13", project_id="P01", meeting_id="M07")

    assert len(result["segments"]) == 1
    assert result["segments"][0]["text"] == "실제 발화"


def test_wrap_segments_output_passes_validate():
    result = wrap_segments(
        [{"start": 0.0, "end": 1.0, "speaker": "1", "text": "안녕"}],
        source="x.m4a", date="2026-07-13", project_id="P01", meeting_id="M07",
    )
    validate(result)
