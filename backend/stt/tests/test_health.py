import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

import backend.stt.health as health


def test_check_stt_health_reports_missing_env_vars(monkeypatch):
    monkeypatch.delenv("CLOVA_SPEECH_INVOKE_URL", raising=False)
    monkeypatch.delenv("CLOVA_SPEECH_SECRET", raising=False)

    rows = health.check_stt_health()

    clova_row = next(r for r in rows if r[0] == "CLOVA Speech")
    assert clova_row[2] == "미설정"
    assert "CLOVA_SPEECH_INVOKE_URL" in clova_row[1]


def test_check_stt_health_reports_configured_when_env_vars_present(monkeypatch):
    monkeypatch.setenv("CLOVA_SPEECH_INVOKE_URL", "https://example.com")
    monkeypatch.setenv("CLOVA_SPEECH_SECRET", "secret")

    rows = health.check_stt_health()

    clova_row = next(r for r in rows if r[0] == "CLOVA Speech")
    assert clova_row[2] == "정상"


def test_check_stt_health_returns_a_row_per_dependency():
    rows = health.check_stt_health()

    names = [r[0] for r in rows]
    assert "CLOVA Speech" in names
    assert any("OpenAI" in n for n in names)
    assert any("Soniox" in n for n in names)
