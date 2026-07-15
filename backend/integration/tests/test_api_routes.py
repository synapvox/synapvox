from fastapi.testclient import TestClient

from backend.integration.api import main as api_main


app = api_main.app
app.dependency_overrides[api_main.require_user] = lambda: {"sub": "test-user"}


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


def test_api_ingest_stt_uses_active_project(monkeypatch):
    import backend.graphrag as graphrag
    from backend.integration import pipeline
    monkeypatch.setattr(api_main, "_graph_runtime", lambda: (None, object(), None))
    monkeypatch.setattr(api_main, "_optional_vector_store", lambda: None)
    monkeypatch.setattr(graphrag, "graph_data", lambda driver, project, database: {
        "nodes": [{"id": "t1", "type": "concept", "label": "그래프", "meta": {}}], "edges": [],
    })
    monkeypatch.setattr(
        pipeline, "ingest_intermediate",
        lambda transcript, store, vector, project: {
            "project_id": project, "meeting_id": transcript["meeting_id"],
            "chunks": [{"chunk_id": "c1"}], "topic_ids": ["t1"], "relations": 0,
        },
    )
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


def test_api_ingest_doc_stores_text_file(monkeypatch):
    import backend.graphrag as graphrag
    from backend.integration import pipeline
    monkeypatch.setattr(api_main, "_graph_runtime", lambda: (None, object(), None))
    monkeypatch.setattr(api_main, "_optional_vector_store", lambda: None)
    monkeypatch.setattr(graphrag, "graph_data", lambda driver, project, database: {
        "nodes": [{"id": "t1", "type": "concept", "label": "graph", "meta": {}}], "edges": [],
    })
    monkeypatch.setattr(
        pipeline, "ingest_document_text",
        lambda text, title, project, store, vector, meeting: {
            "project_id": project, "meeting_id": meeting, "chunks": [{"chunk_id": "c1"}],
            "topic_ids": ["t1"], "relations": 0,
        },
    )

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
        "chunks_ingested": 1,
        "concepts_new": 1,
        "concepts_total": 1,
        "relations_new": 0,
    }


def test_api_graph_and_ask_use_current_project(monkeypatch):
    import backend.graphrag as graphrag

    class _FakeSearch:
        def __init__(self, driver, vector, database):
            pass

        def search(self, project, question, k):
            return [{"chunk_id": "c1", "text": "근거", "meeting_id": "m1", "topics": []}]

    monkeypatch.setattr(api_main, "_graph_runtime", lambda: (object(), object(), "neo4j"))
    monkeypatch.setattr(api_main, "_optional_vector_store", lambda: object())
    monkeypatch.setattr(api_main, "_answer_from_hits", lambda question, hits: question)
    monkeypatch.setattr(
        graphrag, "graph_data",
        lambda driver, project, database: {
            "nodes": [{"id": project, "type": "session", "label": "강의", "meta": {}}], "edges": [],
        },
    )
    monkeypatch.setattr(graphrag, "HybridSearch", _FakeSearch)
    monkeypatch.setattr(
        graphrag, "expansion_for_chunks",
        lambda driver, project, chunk_ids, database: {"nodes": [], "edges": []},
    )
    client = TestClient(app)

    graph = client.get("/api/graph", params={"project": "project-uuid"})
    answer = client.get("/api/ask", params={"project": "project-uuid", "q": "질문", "k": 4})

    assert graph.status_code == 200
    assert graph.json()["nodes"][0]["id"] == "project-uuid"
    assert answer.status_code == 200
    assert answer.json()["answer"] == "질문"
