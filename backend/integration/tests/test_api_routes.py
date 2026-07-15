from fastapi.testclient import TestClient

from backend.integration.api import main as api_main


app = api_main.app


def test_graph_ingest_routes_use_api_prefix():
    documented_post_routes = {
        route.path
        for route in app.routes
        if "POST" in getattr(route, "methods", set()) and getattr(route, "include_in_schema", False)
    }

    assert "/api/ingest-doc" in documented_post_routes
    assert "/api/ingest-stt" in documented_post_routes


def test_legacy_graph_ingest_routes_remain_as_hidden_aliases():
    hidden_post_routes = {
        route.path
        for route in app.routes
        if "POST" in getattr(route, "methods", set()) and not getattr(route, "include_in_schema", True)
    }

    assert "/ingest-doc" in hidden_post_routes
    assert "/ingest-stt" in hidden_post_routes


class _FakeGsvxClient:
    def ingest_transcript(self, transcript, project):
        return {"project": project, "source": transcript["source"], "chunks_ingested": 1}

    def ingest_document_text(self, text, title, project, meeting):
        return {
            "project": project,
            "meeting": meeting,
            "title": title,
            "text": text,
            "chunks_ingested": 1,
        }


def test_api_ingest_stt_relays_active_project(monkeypatch):
    monkeypatch.setattr(api_main, "_gsvx_client", lambda _api_key: _FakeGsvxClient())
    transcript = {
        "source": "lecture.wav",
        "meeting_id": "lecture-01",
        "project_id": "display-name",
        "date": "2026-07-15",
        "mode": "lecture",
        "segments": [
            {"id": 0, "speaker": "A", "start": 0.0, "end": 1.0, "text": "그래프 이론"},
        ],
    }

    response = TestClient(app).post(
        "/api/ingest-stt",
        headers={"X-Project-Id": "project-uuid", "X-API-Key": "test-key"},
        json=transcript,
    )

    assert response.status_code == 200
    assert response.json()["project"] == "project-uuid"


def test_api_ingest_doc_relays_text_file(monkeypatch):
    monkeypatch.setattr(api_main, "_gsvx_client", lambda _api_key: _FakeGsvxClient())

    response = TestClient(app).post(
        "/api/ingest-doc",
        headers={
            "X-Project-Id": "project-uuid",
            "X-Meeting-Id": "lecture-01",
            "X-API-Key": "test-key",
        },
        files={"file": ("notes.txt", b"graph theory notes", "text/plain")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "project": "project-uuid",
        "meeting": "lecture-01",
        "title": "notes",
        "text": "graph theory notes",
        "chunks_ingested": 1,
    }
