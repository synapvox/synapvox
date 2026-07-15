"""vector_store_supabase 테스트. SUPABASE_DB_URL이 없으면 skip (test_graphrag.py의 Neo4j skip과 동일 패턴)."""

import os
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.graphrag.vector_store_supabase import VectorStore

PID = "TEST-vector-store-supabase"


@pytest.fixture
def store():
    if not os.environ.get("SUPABASE_DB_URL"):
        pytest.skip("SUPABASE_DB_URL 미설정 → Supabase vector store 테스트 skip")
    vs = VectorStore()
    vs.reset(PID)
    yield vs
    vs.reset(PID)


def test_add_and_query_ranks_relevant_chunk_first(store):
    store.add_chunks(PID, "M01", [
        {"chunk_id": "c1", "text": "결제 모듈 카드 간편결제", "source_type": "minutes"},
        {"chunk_id": "c2", "text": "오늘 점심 메뉴는 김치찌개였다", "source_type": "minutes"},
    ])
    hits = store.query(PID, "결제", k=2)
    assert hits[0]["chunk_id"] == "c1"


def test_project_isolation(store):
    store.add_chunks(PID, "M01", [{"chunk_id": "a1", "text": "결제 모듈 카드 간편결제"}])
    store.add_chunks("OTHER-PROJECT", "M02", [{"chunk_id": "b1", "text": "결제 모듈 카드 간편결제"}])
    hits = store.query(PID, "결제", k=5)
    assert hits and all(h["chunk_id"] != "b1" for h in hits)


def test_upsert_overwrites_same_chunk_id(store):
    store.add_chunks(PID, "M01", [{"chunk_id": "c1", "text": "초안"}])
    store.add_chunks(PID, "M01", [{"chunk_id": "c1", "text": "수정본"}])
    hits = store.query(PID, "수정본", k=1)
    assert hits[0]["text"] == "수정본"
