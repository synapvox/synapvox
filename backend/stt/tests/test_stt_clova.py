import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.stt.stt_clova import _build_params, _parse_response


def test_parse_response_converts_ms_to_seconds_and_extracts_speaker_label():
    data = {
        "segments": [
            {
                "start": 754200,
                "end": 761800,
                "text": " 안녕하세요 ",
                "speaker": {"label": "1", "name": "", "edited": False},
            },
            {
                "start": 762000,
                "end": 765000,
                "text": "네 반갑습니다",
                "speaker": {"label": "2", "name": "", "edited": False},
            },
        ]
    }

    result = _parse_response(data, "meeting.m4a")

    assert result["source"] == "meeting.m4a"
    assert result["segments"][0] == {
        "start": 754.2, "end": 761.8, "speaker": "1", "text": "안녕하세요",
    }
    assert result["segments"][1]["speaker"] == "2"


def test_parse_response_defaults_speaker_when_missing():
    data = {"segments": [{"start": 0, "end": 1000, "text": "화자분리 실패"}]}

    result = _parse_response(data, "x.m4a")

    assert result["segments"][0]["speaker"] == "UNKNOWN"


def test_build_params_without_boost_keywords_omits_boostings():
    params = _build_params("ko-KR")

    assert "boostings" not in params
    assert params["language"] == "ko-KR"
    assert params["diarization"] == {"enable": True}


def test_build_params_with_boost_keywords_adds_boostings_entry():
    params = _build_params("ko-KR", boost_keywords="추가경정예산안, 그냥드림", boost_weight="7")

    assert params["boostings"] == [{"words": "추가경정예산안, 그냥드림", "weight": "7"}]
