from backend.graphrag.graph_store import GraphStore


class _Result:
    def __init__(self, record=None):
        self.record = record

    def single(self):
        return self.record

    def consume(self):
        return None


class _Session:
    def __init__(self, calls, record=None):
        self.calls = calls
        self.record = record

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def run(self, query, **params):
        self.calls.append((query, params))
        return _Result(self.record)


class _Driver:
    def __init__(self, record=None):
        self.calls = []
        self.record = record

    def session(self, database=None):
        return _Session(self.calls, self.record)


def _store(driver):
    store = GraphStore.__new__(GraphStore)
    store.driver = driver
    store.database = "neo4j"
    return store


def test_load_chunks_uses_one_unwind_query():
    driver = _Driver()
    _store(driver).load_chunks("P1", "M1", [
        {"chunk_id": "c1", "text": "one", "source_type": "transcript"},
        {"chunk_id": "c2", "text": "two", "source_type": "transcript"},
    ])

    assert len(driver.calls) == 1
    query, params = driver.calls[0]
    assert "UNWIND $chunks AS row" in query
    assert [row["chunk_id"] for row in params["chunks"]] == ["c1", "c2"]


def test_load_knowledge_batch_sends_all_graph_data_once():
    driver = _Driver({
        "chunks_loaded": 2,
        "topics_loaded": 2,
        "decisions_loaded": 0,
        "actions_loaded": 0,
        "relations_loaded": 1,
        "concepts_total": 2,
    })
    result = _store(driver).load_knowledge_batch(
        "P1",
        "M1",
        [
            {"chunk_id": "c1", "text": "one"},
            {"chunk_id": "c2", "text": "two"},
        ],
        [
            {"chunk_id": "c1", "topics": [{"topic_id": "t1", "name": "A"}]},
            {"chunk_id": "c2", "topics": [{"topic_id": "t2", "name": "B"}]},
        ],
        [("t1", "t2")],
    )

    assert len(driver.calls) == 1
    query, params = driver.calls[0]
    assert "CALL (chunks, pid, mid)" in query
    assert "CALL (topics, pid, mid)" in query
    assert len(params["chunks"]) == 2
    assert len(params["topics"]) == 2
    assert params["relations"] == [{"left": "t1", "right": "t2"}]
    assert result["concepts_total"] == 2
