"""graphrag 모듈 테스트. Neo4j/Supabase/OpenAI 크리덴셜이 없으면 skip (CONTRIBUTING: 자기 모듈 변경은 가볍게).

로컬 실행 전제: Neo4j 실행 + 환경변수 NEO4J_URI/USER/PASSWORD, VectorStore용 SUPABASE_DB_URL +
OPENAI_API_KEY(기본 embed_fn이 OpenAI라 실제 API 호출 발생).
  docker run -d --name svx-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/synapvox123 neo4j:5.26
"""

import os
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.graphrag import GraphStore, VectorStore, HybridSearch, timeline, meetings_by_topic, decision_history

PID = "TEST-graphrag"

# ── 스키마 계약대로의 최소 fixture ──
INTERMEDIATE = [
    {"project_id": PID, "meeting_id": "M01", "date": "2026-06-15", "pass": "refined",
     "title": "킥오프", "segments": [{"id": 1, "speaker": "A", "start": 0, "end": 5, "text_raw": "결제 범위 논의"}]},
    {"project_id": PID, "meeting_id": "M02", "date": "2026-06-22", "pass": "refined",
     "title": "PG 선정", "segments": [{"id": 1, "speaker": "A", "start": 0, "end": 5, "text_raw": "PG사 확정"}]},
]
CHUNKS = {
    "M01": [{"chunk_id": "M01c1", "source_type": "minutes", "text": "이번 분기 결제 범위는 카드와 간편결제로 한다."}],
    "M02": [{"chunk_id": "M02c1", "source_type": "minutes", "text": "PG사는 토스페이먼츠로 확정한다."}],
}
EXTRACTION = {
    "M01": {"chunk_id": "M01c1",
            "topics": [{"topic_id": "T_pay", "name": "결제 모듈", "aliases": ["결제"]}],
            "decisions": [{"decision_id": "D01", "statement": "카드+간편결제로 범위 확정", "date": "2026-06-15"}],
            "action_items": [{"item_id": "AI01", "task": "PG 비교", "assignee": "C", "due": "2026-06-20"}]},
    "M02": {"chunk_id": "M02c1",
            "topics": [{"topic_id": "T_pay", "name": "결제 모듈", "aliases": ["결제"]},
                       {"topic_id": "T_pg", "name": "PG사 선정"}],
            "decisions": [{"decision_id": "D02", "statement": "PG사 토스페이먼츠 확정", "date": "2026-06-22", "supersedes": "D01"}],
            "action_items": []},
}


@pytest.fixture(scope="module")
def driver():
    try:
        from neo4j import GraphDatabase
        d = GraphDatabase.driver(os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
                                 auth=(os.environ.get("NEO4J_USER", "neo4j"),
                                       os.environ.get("NEO4J_PASSWORD", "synapvox123")))
        d.verify_connectivity()
    except Exception as e:
        pytest.skip(f"Neo4j 미연결 → graphrag 테스트 skip: {e}")
    yield d
    d.close()


@pytest.fixture(scope="module")
def vector_store():
    if not os.environ.get("SUPABASE_DB_URL"):
        pytest.skip("SUPABASE_DB_URL 미설정 → VectorStore(pgvector) 테스트 skip")
    if not os.environ.get("OPENAI_API_KEY"):
        pytest.skip("OPENAI_API_KEY 미설정 → VectorStore 기본 embed_fn(OpenAI) 테스트 skip")
    return VectorStore()  # 기본 embed_fn = openai_embed(임시)


@pytest.fixture(scope="module")
def loaded(driver, vector_store):
    gs, vs = GraphStore(driver), vector_store
    gs.reset(PID); vs.reset(PID)
    for im in INTERMEDIATE:
        mid = gs.load_intermediate(im)
        gs.load_chunks(PID, mid, CHUNKS[mid])
        vs.add_chunks(PID, mid, CHUNKS[mid])
        gs.load_extraction(PID, mid, EXTRACTION[mid])
    yield gs, vs
    gs.reset(PID); vs.reset(PID)


def test_nodes_and_follows(loaded, driver):
    with driver.session() as s:
        n = s.run("MATCH (m:Meeting {project_id:$p}) RETURN count(m) AS c", p=PID).single()["c"]
        assert n == 2
        f = s.run("MATCH (:Meeting {project_id:$p, meeting_id:'M01'})-[:FOLLOWS]->"
                  "(b:Meeting {meeting_id:'M02'}) RETURN count(*) AS c", p=PID).single()["c"]
        assert f == 1  # FOLLOWS 시간순


def test_extraction_nodes_and_edges(loaded, driver):
    with driver.session() as s:
        assert s.run("MATCH (t:Topic {project_id:$p}) RETURN count(t) AS c", p=PID).single()["c"] == 2
        # DISCUSSES: 두 회의가 같은 Topic '결제 모듈' 공유 → 세션 간 연결
        shared = s.run("MATCH (m:Meeting {project_id:$p})-[:DISCUSSES]->(t:Topic {name:'결제 모듈'}) "
                       "RETURN count(DISTINCT m) AS c", p=PID).single()["c"]
        assert shared == 2
        ai = s.run("MATCH (a:ActionItem {project_id:$p})-[:RAISED_IN]->(:Meeting) RETURN count(a) AS c", p=PID).single()["c"]
        assert ai == 1


def test_timeline_and_topic_queries(loaded, driver):
    tl = timeline(driver, PID)
    assert [m["meeting_id"] for m in tl] == ["M01", "M02"]
    by = meetings_by_topic(driver, PID, "결제 모듈")
    assert {m["meeting_id"] for m in by} == {"M01", "M02"}
    by_alias = meetings_by_topic(driver, PID, "결제")  # alias 매칭
    assert len(by_alias) == 2


def test_decision_supersedes(loaded, driver):
    hist = decision_history(driver, PID)
    d02 = next(d for d in hist if d["decision_id"] == "D02")
    assert d02["supersedes"] == "D01"  # 결정 번복 이력
    assert d02["meeting_id"] == "M02"


def test_hybrid_search_expands_and_reranks(loaded, driver):
    gs, vs = loaded
    res = HybridSearch(driver, vs).search(PID, "PG사 어디로 정했나")
    assert res, "검색 결과가 있어야 함"
    top = res[0]
    assert top["chunk_id"] == "M02c1"          # 관련 청크
    assert "PG사 선정" in top["topics"] or "결제 모듈" in top["topics"]  # 그래프 확장으로 주제 붙음
    assert "rerank_score" in top
    assert all(h["meeting_id"] for h in res)   # 회의 매핑


def test_vector_store_project_isolation(vector_store):
    vs = vector_store
    vs.reset("P-A"); vs.reset("P-B")
    vs.add_chunks("P-A", "MA", [{"chunk_id": "a1", "text": "결제 모듈 카드 간편결제"}])
    vs.add_chunks("P-B", "MB", [{"chunk_id": "b1", "text": "결제 모듈 카드 간편결제"}])
    hits = vs.query("P-A", "결제", k=5)
    assert hits and all(h["chunk_id"] != "b1" for h in hits)  # 다른 프로젝트 누출 없음
    vs.reset("P-A"); vs.reset("P-B")


def test_vector_store_upsert_overwrites_same_chunk_id(vector_store):
    vs = vector_store
    vs.reset("P-UPSERT")
    vs.add_chunks("P-UPSERT", "M01", [{"chunk_id": "c1", "text": "초안"}])
    vs.add_chunks("P-UPSERT", "M01", [{"chunk_id": "c1", "text": "수정본"}])
    hits = vs.query("P-UPSERT", "수정본", k=1)
    assert hits[0]["text"] == "수정본"
    vs.reset("P-UPSERT")
