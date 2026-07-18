import json

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


def test_project_can_move_to_and_restore_from_trash(monkeypatch):
    calls = []
    monkeypatch.setattr(
        api_main,
        "_set_project_trashed",
        lambda user, project, trashed: calls.append((user, project, trashed)) or {
            "id": project, "trashed": trashed,
        },
    )
    client = TestClient(app)

    trashed = client.patch("/api/projects/p-1/trash", json={"trashed": True})
    restored = client.patch("/api/projects/p-1/trash", json={"trashed": False})

    assert trashed.status_code == 200 and trashed.json()["trashed"] is True
    assert restored.status_code == 200 and restored.json()["trashed"] is False
    assert calls == [("test-user", "p-1", True), ("test-user", "p-1", False)]


def test_permanent_project_delete_cleans_graphiti_and_database(monkeypatch):
    calls = []

    class _Graphiti:
        def reset(self, project):
            calls.append(("graphiti", project))
            return {"ok": True}

    monkeypatch.setattr(api_main, "_owned_project_record", lambda user, project: {
        "id": project, "name": "강의", "trashed_at": "2026-07-16",
    })
    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    monkeypatch.setattr(
        api_main,
        "_delete_project_rows",
        lambda user, project: calls.append(("database", project)) or ["user/project/file.pdf"],
    )

    response = TestClient(app).delete("/api/projects/p-1")

    assert response.status_code == 200
    assert response.json()["storage_paths"] == ["user/project/file.pdf"]
    assert set(calls) == {("graphiti", "p-1"), ("database", "p-1")}


def test_permanent_project_delete_succeeds_when_graphiti_cleanup_fails(monkeypatch):
    class _Graphiti:
        def reset(self, project):
            raise RuntimeError("graph offline")

    monkeypatch.setattr(api_main, "_owned_project_record", lambda user, project: {
        "id": project, "name": "강의", "trashed_at": "2026-07-16",
    })
    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    monkeypatch.setattr(
        api_main,
        "_delete_project_rows",
        lambda user, project: ["user/project/file.pdf"],
    )

    response = TestClient(app).delete("/api/projects/p-1")

    assert response.status_code == 200
    assert response.json()["database_deleted"] is True
    assert response.json()["graph_deleted"] is False
    assert response.json()["warnings"]


def test_permanent_project_delete_succeeds_when_only_graphiti_data_exists(monkeypatch):
    class _Graphiti:
        def reset(self, project):
            return {"success": True, "nodes_deleted": 3}

    monkeypatch.setattr(api_main, "_owned_project_record", lambda user, project: None)
    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())

    def missing_database(user, project):
        raise LookupError("project not found")

    monkeypatch.setattr(api_main, "_delete_project_rows", missing_database)

    response = TestClient(app).delete("/api/projects/p-1")

    assert response.status_code == 200
    assert response.json()["graph_deleted"] is True
    assert response.json()["database_deleted"] is False


def test_permanent_project_delete_requires_trash(monkeypatch):
    monkeypatch.setattr(api_main, "_owned_project_record", lambda user, project: {
        "id": project, "name": "강의", "trashed_at": None,
    })

    response = TestClient(app).delete("/api/projects/p-1")

    assert response.status_code == 409


def test_legacy_graph_ingest_routes_remain_as_hidden_aliases():
    hidden_post_routes = {
        route.path
        for route in app.routes
        if "POST" in getattr(route, "methods", set()) and not getattr(route, "include_in_schema", True)
    }

    assert "/ingest-doc" in hidden_post_routes
    assert "/ingest-stt" in hidden_post_routes


def test_api_ingest_stt_uses_active_project(monkeypatch):
    captured = {}

    class _Graphiti:
        def ingest_transcript(self, transcript, project):
            captured["project"] = project
            return {
                "chunks_ingested": 1, "concepts_new": 1,
                "concepts_total": 1, "relations_new": 0, "sessions": ["episode-1"],
            }

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    monkeypatch.setattr(api_main, "_owned_transcript_exists", lambda user, project, meeting: True)
    monkeypatch.setattr(api_main, "_owned_recording_source_id", lambda user, project, meeting: "recording-1")
    monkeypatch.setattr(
        api_main,
        "_store_source_graph_episode_ids",
        lambda user, source, episodes: captured.update(source=source, episodes=episodes),
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
    assert captured["project"] == "project-uuid"
    assert captured["source"] == "recording-1"
    assert captured["episodes"] == ["episode-1"]


def test_api_ingest_doc_stores_text_file(monkeypatch):
    captured = {}

    class _Graphiti:
        def ingest_document_text(self, text, title, project, meeting, content_date=None):
            captured.update(text=text, title=title, project=project, meeting=meeting,
                            content_date=content_date)
            return {
                "chunks_ingested": 1, "concepts_new": 1,
                "concepts_total": 1, "relations_new": 0, "sessions": ["episode-doc"],
            }

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    monkeypatch.setattr(api_main, "_owned_source_record", lambda user, source: {
        "id": source, "project_id": "project-uuid", "recording_id": None,
        "kind": "document", "original_name": "notes.txt", "source_payload": {},
    })
    monkeypatch.setattr(
        api_main,
        "_store_source_graph_episode_ids",
        lambda user, source, episodes: captured.update(stored=(source, episodes)),
    )

    response = TestClient(app).post(
        "/api/ingest-doc",
        headers={
            "X-Project-Id": "project-uuid",
            "X-Meeting-Id": "lecture-01",
            "X-Source-Id": "material-123",
            "X-API-Key": "test-key",
        },
        files={"file": ("notes.txt", b"graph theory notes", "text/plain")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "project": "project-uuid",
        "meeting": "lecture-01",
        "source_id": "material-123",
        "title": "notes",
        "chunks_ingested": 1,
        "concepts_new": 1,
        "concepts_total": 1,
        "relations_new": 0,
        "sessions": ["episode-doc"],
    }
    assert captured["text"] == "graph theory notes"
    assert captured["content_date"] is None
    assert captured["title"] == "notes"
    assert captured["project"] == "project-uuid"
    assert captured["meeting"] == "lecture-01"
    assert captured["stored"] == ("material-123", ["episode-doc"])


def test_api_ingest_doc_passes_user_content_date(monkeypatch):
    captured = {}

    class _Graphiti:
        def ingest_document_text(self, text, title, project, meeting, content_date=None):
            captured["content_date"] = content_date
            return {
                "chunks_ingested": 1, "concepts_new": 1,
                "concepts_total": 1, "relations_new": 0, "sessions": ["episode-doc"],
            }

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    monkeypatch.setattr(api_main, "_owned_source_record", lambda user, source: {
        "id": source, "project_id": "project-uuid", "recording_id": None,
        "kind": "document", "original_name": "notes.txt", "source_payload": {},
    })
    monkeypatch.setattr(
        api_main, "_store_source_graph_episode_ids", lambda user, source, episodes: None)

    response = TestClient(app).post(
        "/api/ingest-doc",
        headers={
            "X-Project-Id": "project-uuid",
            "X-Source-Id": "material-123",
            "X-Content-Date": "2026-03-02",
            "X-API-Key": "test-key",
        },
        files={"file": ("notes.txt", b"graph theory notes", "text/plain")},
    )

    assert response.status_code == 200
    assert captured["content_date"] == "2026-03-02"


def test_api_ingest_doc_rejects_malformed_content_date():
    response = TestClient(app).post(
        "/api/ingest-doc",
        headers={
            "X-Project-Id": "project-uuid",
            "X-Content-Date": "03/02/2026",
            "X-API-Key": "test-key",
        },
        files={"file": ("notes.txt", b"graph theory notes", "text/plain")},
    )

    assert response.status_code == 400
    assert "YYYY-MM-DD" in response.json()["detail"]


def test_api_graph_and_ask_use_current_project(monkeypatch):
    class _Graphiti:
        def graph(self, project):
            return {
            "nodes": [{"id": project, "type": "session", "label": "강의", "meta": {}}], "edges": [],
            }

        def ask(self, project, question, k, meeting_id=None):
            return {"answer": question, "hits": [], "expansion": {"nodes": [], "edges": []}}

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    client = TestClient(app)

    graph = client.get("/api/graph", params={"project": "project-uuid"})
    answer = client.get("/api/ask", params={"project": "project-uuid", "q": "질문", "k": 4})

    assert graph.status_code == 200
    assert graph.json()["nodes"][0]["id"] == "project-uuid"
    assert answer.status_code == 200
    assert answer.json()["answer"] == "질문"


def test_api_ask_stream_emits_deltas_then_focus_graph(monkeypatch):
    class _Graphiti:
        def ask(self, project, question, k, meeting_id=None):
            return {
                "answer": "미분은 변화율입니다.",
                "hits": [],
                "expansion": {
                    "nodes": [{"id": "t1", "type": "concept", "label": "미분", "meta": {}}],
                    "edges": [],
                },
            }

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())

    response = TestClient(app).get(
        "/api/ask-stream",
        params={"project": "project-uuid", "q": "미분이 뭐야", "k": 4},
    )
    events = [json.loads(line) for line in response.text.splitlines() if line]

    assert response.status_code == 200
    assert "".join(event.get("text", "") for event in events) == "미분은 변화율입니다."
    assert events[-1]["type"] == "complete"
    assert events[-1]["answer"] == "미분은 변화율입니다."
    assert events[-1]["expansion"]["nodes"][0]["id"] == "t1"


def test_has_open_math_detects_unclosed_delimiters():
    assert api_main._has_open_math("합은 $$L = 1")
    assert not api_main._has_open_math("합은 $$L = 1$$ 이다")
    assert api_main._has_open_math("학습률 $\\eta")
    assert not api_main._has_open_math("학습률 $\\eta$ 는 보폭")
    assert api_main._has_open_math("블록 \\[ x")
    assert not api_main._has_open_math("블록 \\[ x \\] 끝")
    assert not api_main._has_open_math("수식 없는 문장")


def test_api_ask_stream_relays_tokens_and_buffers_open_math(monkeypatch):
    class _Graphiti:
        def ask_stream(self, project, question, k, meeting_id=None, history=None):
            yield {"type": "status", "stage": "answering"}
            yield {"type": "delta", "text": "손실은 "}
            yield {"type": "delta", "text": "$$L"}
            yield {"type": "delta", "text": " = 1$$"}
            yield {"type": "delta", "text": " 이다 [1]"}
            yield {
                "type": "complete",
                "answer": "손실은 $$L = 1$$ 이다 [1]",
                "hits": [{"uuid": "f1"}],
                "expansion": {"nodes": [], "edges": []},
            }

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())

    response = TestClient(app).get(
        "/api/ask-stream",
        params={"project": "project-uuid", "q": "손실이 뭐야", "k": 4},
    )
    events = [json.loads(line) for line in response.text.splitlines() if line]
    deltas = [event["text"] for event in events if event["type"] == "delta"]

    assert response.status_code == 200
    # 검색 시작(searching) → 검색 종료·생성 시작(answering) 상태가 delta보다 먼저 온다.
    assert [event["stage"] for event in events if event["type"] == "status"] == ["searching", "answering"]
    assert events[0]["type"] == "status"
    # 열린 $$ 블록은 닫힐 때까지 버퍼링 — 어떤 delta도 미완성 수식으로 끝나지 않는다.
    for index in range(len(deltas)):
        assert not api_main._has_open_math("".join(deltas[:index + 1]))
    assert "".join(deltas) == "손실은 $$L = 1$$ 이다 [1]"
    assert events[-1]["type"] == "complete"
    assert events[-1]["answer"] == "손실은 $$L = 1$$ 이다 [1]"
    assert events[-1]["hits"] == [{"uuid": "f1"}]


def test_api_ask_stream_post_uses_graphiti_question(monkeypatch):
    captured = {}

    class _Graphiti:
        def ask(self, project, question, k, meeting_id=None, history=None):
            captured.update(project=project, question=question, k=k, meeting_id=meeting_id, history=history)
            return {"answer": "이전 대화를 이어서 답변", "hits": [], "expansion": {"nodes": [], "edges": []}}

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())

    response = TestClient(app).post(
        "/api/ask-stream",
        json={
            "project": "project-uuid",
            "q": "그럼 제약은?",
            "history": [
                {"role": "user", "text": "KKT가 뭐야?"},
                {"role": "assistant", "text": "최적화의 필요 조건입니다."},
            ],
        },
    )

    assert response.status_code == 200
    assert captured == {
        "project": "project-uuid",
        "question": "그럼 제약은?",
        "k": 6,
        "meeting_id": None,
        "history": [
            {"role": "user", "text": "KKT가 뭐야?"},
            {"role": "assistant", "text": "최적화의 필요 조건입니다."},
        ],
    }


def test_api_ask_stream_post_threads_meeting_id(monkeypatch):
    captured = {}

    class _Graphiti:
        def ask(self, project, question, k, meeting_id=None):
            captured["meeting_id"] = meeting_id
            return {"answer": "답변", "hits": [], "expansion": {"nodes": [], "edges": []}}

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())

    response = TestClient(app).post(
        "/api/ask-stream",
        json={"project": "project-uuid", "q": "이 회의에서는?", "meeting_id": "M07"},
    )

    assert response.status_code == 200
    assert captured["meeting_id"] == "M07"


def test_api_ask_threads_meeting_id(monkeypatch):
    captured = {}

    class _Graphiti:
        def ask(self, project, question, k, meeting_id=None):
            captured["meeting_id"] = meeting_id
            return {"answer": question, "hits": [], "expansion": {"nodes": [], "edges": []}}

    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())

    response = TestClient(app).get(
        "/api/ask", params={"project": "project-uuid", "q": "질문", "k": 4, "meeting_id": "M07"}
    )

    assert response.status_code == 200
    assert captured["meeting_id"] == "M07"

def test_delete_source_removes_owned_graphiti_episodes(monkeypatch):
    source = {
        "id": "recording-123",
        "project_id": "project-uuid",
        "recording_id": "recording-123",
        "kind": "audio",
        "original_name": "lecture.webm",
        "source_payload": {"graphEpisodeIds": ["episode-1", "episode-2"]},
    }
    deleted = []

    class _Graphiti:
        def find_episode_ids(self, project, **kwargs):
            raise AssertionError("stored episode IDs must skip compatibility lookups")

        def delete_episodes(self, episode_ids):
            deleted.extend(episode_ids)
            return {"success": True, "episodes_deleted": 2, "entities_deleted": 3}

    monkeypatch.setattr(api_main, "_owned_source_record", lambda user, source_id: source)
    monkeypatch.setattr(api_main, "_owned_source_bundle_records", lambda user, record: [record])
    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    response = TestClient(app).delete("/api/source-graph", params={"source_id": "recording-123"})

    assert response.status_code == 200
    assert response.json()["episodes_deleted"] == 2
    assert response.json()["orphan_entities_deleted"] == 3
    assert set(deleted) == {"episode-1", "episode-2"}


def test_delete_source_everywhere_uses_hints_when_database_row_is_missing(monkeypatch):
    deleted = []

    class _Graphiti:
        def find_episode_ids(self, project, **kwargs):
            assert project == "project-uuid"
            return ["episode-orphan"]

        def delete_episodes(self, episode_ids):
            deleted.extend(episode_ids)
            return {"success": True, "episodes_deleted": 1, "entities_deleted": 2}

    monkeypatch.setattr(api_main, "_owned_source_record", lambda user, source_id: None)
    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    monkeypatch.setattr(
        api_main,
        "_delete_source_rows",
        lambda user, source, recording: {
            "storage_paths": [],
            "sources_deleted": 0,
            "transcripts_deleted": 0,
        },
    )

    response = TestClient(app).delete(
        "/api/sources/source-missing",
        params={
            "project_id": "project-uuid",
            "meeting_id": "meeting-1",
            "title": "lecture.wav",
        },
    )

    assert response.status_code == 200
    assert response.json()["graph_deleted"] is True
    assert response.json()["database_deleted"] is False
    assert deleted == ["episode-orphan"]


def test_delete_source_everywhere_keeps_database_success_when_graphiti_fails(monkeypatch):
    source = {
        "id": "source-1",
        "project_id": "project-uuid",
        "recording_id": None,
        "kind": "document",
        "original_name": "notes.pdf",
        "source_payload": {"graphEpisodeIds": ["episode-1"]},
    }

    class _Graphiti:
        def delete_episodes(self, episode_ids):
            raise RuntimeError("graph offline")

    monkeypatch.setattr(api_main, "_owned_source_record", lambda user, source_id: source)
    monkeypatch.setattr(api_main, "_owned_source_bundle_records", lambda user, record: [record])
    monkeypatch.setattr(api_main, "_gsvx_client", lambda: _Graphiti())
    monkeypatch.setattr(
        api_main,
        "_delete_source_rows",
        lambda user, source_id, recording_id: {
            "storage_paths": ["user/project/notes.pdf"],
            "sources_deleted": 1,
            "transcripts_deleted": 0,
        },
    )

    response = TestClient(app).delete(
        "/api/sources/source-1",
        params={"project_id": "project-uuid"},
    )

    assert response.status_code == 200
    assert response.json()["database_deleted"] is True
    assert response.json()["graph_deleted"] is False
    assert response.json()["storage_paths"] == ["user/project/notes.pdf"]
