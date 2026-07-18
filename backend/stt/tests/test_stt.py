import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

import backend.stt.stt as stt


def test_transcribe_uses_soniox_by_default(monkeypatch):
    monkeypatch.setattr(stt.stt_soniox, "transcribe", lambda audio_path, language_hints=None: {
        "source": audio_path, "segments": [{"start": 0.0, "end": 1.0, "speaker": "1", "text": "soniox"}],
    })
    monkeypatch.setattr(stt.stt_clova, "transcribe", lambda *a, **k: (_ for _ in ()).throw(AssertionError("clova should not be called")))

    result = stt.transcribe("meeting.m4a")

    assert result["segments"][0]["text"] == "soniox"


def test_transcribe_falls_back_to_clova_on_soniox_failure(monkeypatch):
    monkeypatch.setattr(stt.stt_soniox, "transcribe", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("soniox down")))
    monkeypatch.setattr(stt.stt_clova, "transcribe", lambda audio_path, language="ko-KR": {
        "source": audio_path, "segments": [{"start": 0.0, "end": 1.0, "speaker": "1", "text": "clova"}],
    })

    result = stt.transcribe("meeting.m4a")

    assert result["segments"][0]["text"] == "clova"


def test_transcribe_with_materials_falls_back_to_clova_on_soniox_failure(monkeypatch):
    monkeypatch.setattr(
        stt.stt_soniox, "transcribe_with_materials",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("soniox down")),
    )
    monkeypatch.setattr(
        stt.stt_clova, "transcribe_with_materials",
        lambda audio_path, material_text=None, past_meeting_texts=None, language="ko-KR": {
            "source": audio_path, "segments": [{"start": 0.0, "end": 1.0, "speaker": "1", "text": "clova"}],
        },
    )

    result = stt.transcribe_with_materials("meeting.m4a", material_text="자료")

    assert result["segments"][0]["text"] == "clova"


def test_clova_language_from_hints_defaults_to_ko_kr():
    assert stt._clova_language_from_hints(None) == "ko-KR"
    assert stt._clova_language_from_hints(["ko"]) == "ko-KR"
    assert stt._clova_language_from_hints(["en"]) == "en"
