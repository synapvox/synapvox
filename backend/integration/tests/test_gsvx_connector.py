import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.integration import gsvx_connector
from backend.integration.gsvx_connector import (
    GsvxClient,
    GsvxError,
    split_for_ingest,
    transcript_title,
    transcript_to_text,
)


def _intermediate(segment_texts: list[str] | None = None) -> dict:
    texts = segment_texts or ["회의를 시작하겠습니다.", "네, 자료 공유드릴게요."]
    return {
        "source": "meeting.m4a",
        "meeting_id": "M01",
        "project_id": "P01",
        "date": "2026-07-15",
        "mode": "meeting",
        "segments": [
            {"id": i, "speaker": "A" if i % 2 == 0 else "B",
             "start": float(i), "end": float(i) + 0.9, "text": t}
            for i, t in enumerate(texts)
        ],
    }


# ── 변환: 중간포맷 → gsvx 텍스트 ─────────────────────────


def test_transcript_to_text_keeps_speaker_and_order():
    text = transcript_to_text(_intermediate())
    assert text == "A: 회의를 시작하겠습니다.\nB: 네, 자료 공유드릴게요."


def test_transcript_to_text_rejects_broken_intermediate():
    broken = _intermediate()
    del broken["meeting_id"]
    with pytest.raises(ValueError):
        transcript_to_text(broken)


def test_transcript_title_reflects_mode():
    assert transcript_title(_intermediate()) == "2026-07-15 회의 전사 (M01)"
    lecture = _intermediate()
    lecture["mode"] = "lecture"
    assert "강의" in transcript_title(lecture)


# ── 분할: gsvx 50,000자 상한(413) 대응 ───────────────────
# 상한 이내(대부분의 경우)는 분할 없이 그대로 — 초과 시에만 구조 경계 + overlap.


def test_split_for_ingest_within_limit_is_untouched_single_part():
    text = "A: 첫 발화\nB: 둘째 발화\n\n다음 문단"
    assert split_for_ingest(text) == [text]


def test_split_for_ingest_empty_text_gives_no_parts():
    assert split_for_ingest("   \n  ") == []


def test_split_for_ingest_cuts_on_line_boundaries_without_losing_lines():
    lines = [f"A: 발화 {i:03d}" for i in range(50)]
    parts = split_for_ingest("\n".join(lines), limit=100)

    assert len(parts) > 1
    assert all(len(p) <= 100 for p in parts)
    covered = {line for p in parts for line in p.split("\n")}
    assert covered == set(lines)  # 줄 유실 없음 (overlap으로 중복은 있을 수 있음)
    for p in parts:
        assert all(line in lines for line in p.split("\n"))  # 발화 중간 절단 없음


def test_split_for_ingest_overlaps_consecutive_parts():
    lines = [f"A: 발화 {i:03d}" for i in range(60)]
    parts = split_for_ingest("\n".join(lines), limit=120, overlap=30)

    assert len(parts) > 1
    for prev, nxt in zip(parts, parts[1:]):
        # 다음 파트는 직전 파트의 끝 줄(들)로 시작한다 — 경계 맥락이 양쪽에 존재
        assert nxt.split("\n")[0] in prev.split("\n")


def test_split_for_ingest_prefers_paragraph_boundary():
    paragraphs = [f"문단 {i} 첫 줄입니다.\n문단 {i} 둘째 줄입니다." for i in range(8)]
    parts = split_for_ingest("\n\n".join(paragraphs), limit=120, overlap=0)

    # 줄 경계가 아니라 문단(빈 줄) 경계에서 갈라진다 — 문단이 반으로 잘리지 않음
    assert parts == ["\n\n".join(paragraphs[:4]), "\n\n".join(paragraphs[4:])]


def test_split_for_ingest_force_splits_oversized_single_line_with_overlap():
    parts = split_for_ingest("가" * 250, limit=100)

    assert all(len(p) <= 100 for p in parts)
    for prev, nxt in zip(parts, parts[1:]):
        assert nxt.startswith(prev[-25:])  # 문자 단위 overlap(limit//4)
    # 전체 내용 유실 없음: 이어붙이면 원문을 모두 포함
    merged = parts[0]
    for p in parts[1:]:
        merged += p[25:]
    assert merged == "가" * 250


# ── 클라이언트: 집계·에러 매핑 (HTTP는 가짜로 대체) ──────


class _RecordingClient(GsvxClient):
    """ingest_text만 가로채 gsvx 응답 형태를 흉내 낸다 — 네트워크 없음."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.calls = []

    def ingest_text(self, text, title, project=None, name=None):
        self.calls.append({"text": text, "title": title, "project": project})
        return {
            "session_key": title,
            "stats": {"segments": 1, "mentions": 3,
                      "concepts_total": 10 + len(self.calls),
                      "concepts_new": 2, "relations_new": 1},
            "pipeline": [],
        }


def test_ingest_transcript_uses_project_id_and_frontend_contract():
    client = _RecordingClient()
    result = client.ingest_transcript(_intermediate())

    assert client.calls[0]["project"] == "P01"  # 중간포맷 project_id → gsvx 네임스페이스
    assert client.calls[0]["text"].startswith("A: ")
    # 프론트 App.tsx가 기대하는 필드
    assert result["chunks_ingested"] == 1
    assert result["concepts_total"] == 11


def test_ingest_transcript_explicit_project_overrides_intermediate():
    client = _RecordingClient()
    client.ingest_transcript(_intermediate(), project="P-BIO")
    assert client.calls[0]["project"] == "P-BIO"


def test_long_transcript_is_split_into_numbered_sessions():
    client = _RecordingClient()
    client.text_limit = 60
    result = client.ingest_transcript(_intermediate(["긴 발화입니다 " * 3] * 4))

    assert result["chunks_ingested"] == len(client.calls) > 1
    assert client.calls[0]["title"].endswith(f"(1/{len(client.calls)})")
    assert result["concepts_new"] == 2 * len(client.calls)


def test_ingest_document_text_rejects_empty():
    with pytest.raises(ValueError):
        _RecordingClient().ingest_document_text("   ", "빈 자료")


def test_ingest_text_maps_gsvx_error_detail(monkeypatch):
    class _FakeResponse:
        status_code = 413

        @staticmethod
        def json():
            return {"detail": "텍스트가 너무 깁니다"}

    monkeypatch.setattr(gsvx_connector.requests, "post", lambda *a, **k: _FakeResponse())
    with pytest.raises(GsvxError) as exc_info:
        GsvxClient().ingest_text("본문", "제목")
    assert exc_info.value.status_code == 413
    assert "너무 깁니다" in exc_info.value.detail


def test_ingest_text_wraps_connection_failure(monkeypatch):
    def _boom(*args, **kwargs):
        raise gsvx_connector.requests.ConnectionError("refused")

    monkeypatch.setattr(gsvx_connector.requests, "post", _boom)
    with pytest.raises(GsvxError) as exc_info:
        GsvxClient().ingest_text("본문", "제목")
    assert exc_info.value.status_code is None
