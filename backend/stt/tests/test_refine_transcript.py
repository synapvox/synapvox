import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

import pytest

from backend.stt.refine_transcript import _parse_llm_output, build_refinement_prompt

SEGMENTS = [
    {"id": 0, "speaker": "A", "start": 0.0, "end": 2.0, "text": "추가경영예산안을 논의합니다"},
    {"id": 1, "speaker": "B", "start": 2.0, "end": 4.0, "text": "네 알겠습니다"},
]


def test_build_refinement_prompt_includes_transcript_and_material():
    prompt = build_refinement_prompt(SEGMENTS, material_text="이번 회의 안건: 추가경정예산안")

    assert "추가경영예산안" in prompt
    assert "추가경정예산안" in prompt
    assert '"id": 0' in prompt


def test_build_refinement_prompt_includes_past_meetings():
    prompt = build_refinement_prompt(SEGMENTS, past_meeting_texts=["1차 회의: 결제 모듈 논의", "2차 회의: 일정 조정"])

    assert "결제 모듈" in prompt
    assert "일정 조정" in prompt


def test_build_refinement_prompt_notes_absence_of_materials():
    prompt = build_refinement_prompt(SEGMENTS)

    assert "사전 자료 없음" in prompt


def test_parse_llm_output_maps_id_to_corrected_text():
    raw = json.dumps({"segments": [{"id": 0, "text": "추가경정예산안을 논의합니다"}, {"id": 1, "text": "네 알겠습니다"}]})

    corrections = _parse_llm_output(raw, expected_ids={0, 1})

    assert corrections[0] == "추가경정예산안을 논의합니다"
    assert corrections[1] == "네 알겠습니다"


def test_parse_llm_output_rejects_id_mismatch():
    raw = json.dumps({"segments": [{"id": 0, "text": "x"}]})

    with pytest.raises(ValueError, match="mismatch"):
        _parse_llm_output(raw, expected_ids={0, 1})


def test_parse_llm_output_rejects_missing_segments_key():
    with pytest.raises(ValueError, match="segments"):
        _parse_llm_output(json.dumps({"foo": "bar"}), expected_ids={0})


def test_parse_llm_output_rejects_invalid_json():
    with pytest.raises(json.JSONDecodeError):
        _parse_llm_output("not json", expected_ids={0})
