import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.integration import gsvx_connector
from backend.integration.gsvx_connector import (
    GsvxClient,
    GsvxError,
    document_title,
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


def test_transcript_title_uses_original_audio_filename():
    assert transcript_title(_intermediate()) == "meeting.m4a"


def test_transcript_title_falls_back_when_source_is_missing():
    transcript = _intermediate()
    transcript["source"] = ""
    assert transcript_title(transcript) == "2026-07-15 회의 전사"


def test_document_title_appends_meeting_id_when_given():
    assert document_title("slides", "M01") == "slides (M01)"


def test_document_title_unscoped_without_meeting_id():
    assert document_title("slides") == "slides"


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
    """ingest_texts만 가로채 Graphiti 벌크 응답 형태를 흉내 낸다."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.calls = []

    def ingest_texts(self, texts, title, project=None, name=None):
        for i, text in enumerate(texts):
            chunk_title = title if len(texts) == 1 else f"{title} ({i + 1}/{len(texts)})"
            self.calls.append({"text": text, "title": chunk_title, "project": project})
        return {
            "session_key": title,
            "session_keys": [call["title"] for call in self.calls],
            "stats": {"segments": 1, "mentions": 3,
                      "concepts_total": 10 + len(self.calls),
                      "concepts_new": 2 * len(texts), "relations_new": len(texts)},
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


def test_long_transcript_is_split_into_numbered_sessions(monkeypatch):
    monkeypatch.setenv("GRAPHITI_CHUNK_CHARS", "60")
    client = _RecordingClient()
    result = client.ingest_transcript(_intermediate(["긴 발화입니다 " * 3] * 4))

    assert result["chunks_ingested"] == len(client.calls) > 1
    assert client.calls[0]["title"].endswith(f"(1/{len(client.calls)})")
    assert result["concepts_new"] == 2 * len(client.calls)


def test_transcript_is_ingested_as_one_episode_by_default():
    client = _RecordingClient()
    result = client.ingest_transcript(_intermediate(["가" * 500, "나" * 500]))

    assert result["chunks_ingested"] == 1
    assert len(client.calls) == 1
    assert "가" * 500 in client.calls[0]["text"]
    assert "나" * 500 in client.calls[0]["text"]


def test_ingest_document_text_rejects_empty():
    with pytest.raises(ValueError):
        _RecordingClient().ingest_document_text("   ", "빈 자료")


def test_ingest_document_text_scopes_title_to_meeting_when_given():
    client = _RecordingClient()
    client.ingest_document_text("자료 본문", "slides", project="P01", meeting_id="M01")
    assert client.calls[0]["title"] == "slides (M01)"
    assert client.calls[0]["project"] == "P01"


def test_ingest_document_text_unscoped_without_meeting_id():
    client = _RecordingClient()
    client.ingest_document_text("자료 본문", "slides", project="P01")
    assert client.calls[0]["title"] == "slides"


def test_ingest_text_maps_gsvx_error_detail(monkeypatch):
    class _FakeResponse:
        status_code = 413

        @staticmethod
        def json():
            return {"detail": "텍스트가 너무 깁니다"}

    monkeypatch.setattr(gsvx_connector.requests, "request", lambda *a, **k: _FakeResponse())
    with pytest.raises(GsvxError) as exc_info:
        GsvxClient().ingest_text("본문", "제목", "P01")
    assert exc_info.value.status_code == 413
    assert "너무 깁니다" in exc_info.value.detail


def test_ingest_text_wraps_connection_failure(monkeypatch):
    def _boom(*args, **kwargs):
        raise gsvx_connector.requests.ConnectionError("refused")

    monkeypatch.setattr(gsvx_connector.requests, "request", _boom)
    with pytest.raises(GsvxError) as exc_info:
        GsvxClient().ingest_text("본문", "제목", "P01")
    assert exc_info.value.status_code is None


def test_ingest_ask_and_reset_use_official_graphiti_contract(monkeypatch):
    calls = []

    class _FakeResponse:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    def fake_request(method, url, **kwargs):
        calls.append((method, url, kwargs.get("params"), kwargs.get("json")))
        if url.endswith("/search"):
            return _FakeResponse({"facts": []})
        return _FakeResponse({"success": True})

    monkeypatch.setattr(gsvx_connector.requests, "request", fake_request)
    client = GsvxClient(base_url="https://graphiti.example")
    monkeypatch.setattr(client, "_graph_counts", lambda project: {"concepts": 0, "relations": 0})
    monkeypatch.setattr(client, "_expansion_for_facts", lambda project, facts: {"nodes": [], "edges": []})
    monkeypatch.setattr(client, "_answer_from_facts", lambda question, facts: "근거 없음")
    client.ingest_text("강의 내용", "1주차", "project-uuid")
    client.ask("project-uuid", "미분이 뭐야", 6)
    client.reset("project-uuid")

    assert calls[0][0:2] == ("POST", "https://graphiti.example/messages")
    assert calls[0][3]["group_id"] == "project-uuid"
    assert calls[0][3]["messages"][0]["content"] == "강의 내용"
    assert calls[1] == (
        "POST", "https://graphiti.example/search", None,
        {"group_ids": ["project-uuid"], "query": "미분이 뭐야", "max_facts": 6},
    )
    assert calls[2] == (
        "DELETE", "https://graphiti.example/group/project-uuid", None, None,
    )


def test_ask_includes_meeting_id_in_search_body_when_given(monkeypatch):
    calls = []

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"facts": []}

    def fake_request(method, url, **kwargs):
        calls.append(kwargs.get("json"))
        return _FakeResponse()

    monkeypatch.setattr(gsvx_connector.requests, "request", fake_request)
    client = GsvxClient(base_url="https://graphiti.example")
    monkeypatch.setattr(client, "_graph_counts", lambda project: {"concepts": 0, "relations": 0})
    monkeypatch.setattr(client, "_expansion_for_facts", lambda project, facts: {"nodes": [], "edges": []})
    monkeypatch.setattr(client, "_answer_from_facts", lambda question, facts: "근거 없음")

    client.ask("project-uuid", "이 회의에서 결정된 건?", 6, meeting_id="M07")
    assert calls[0] == {"group_ids": ["project-uuid"], "query": "이 회의에서 결정된 건?", "max_facts": 6,
                        "meeting_id": "M07"}

    client.ask("project-uuid", "질문", 6)  # meeting_id 생략 시 기존과 동일(필드 자체가 없음)
    assert "meeting_id" not in calls[1]


def test_prune_orphans_uses_project_scoped_graphiti_route(monkeypatch):
    calls = []

    class _FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"success": True, "entities_deleted": 2}

    def fake_request(method, url, **kwargs):
        calls.append((method, url))
        return _FakeResponse()

    monkeypatch.setattr(gsvx_connector.requests, "request", fake_request)
    result = GsvxClient(base_url="https://graphiti.example").prune_orphans("project/uuid")

    assert result["entities_deleted"] == 2
    assert calls == [("DELETE", "https://graphiti.example/group/project%2Fuuid/orphans")]


def test_delete_episodes_uses_one_bulk_request(monkeypatch):
    calls = []

    class _FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"success": True, "episodes_deleted": 2, "entities_deleted": 4}

    def fake_request(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        return _FakeResponse()

    monkeypatch.setattr(gsvx_connector.requests, "request", fake_request)
    result = GsvxClient(base_url="https://graphiti.example").delete_episodes(
        ["episode-2", "episode-1", "episode-2"]
    )

    assert result["episodes_deleted"] == 2
    assert calls == [(
        "POST",
        "https://graphiti.example/episodes/delete",
        {"episode_ids": ["episode-2", "episode-1"]},
    )]
