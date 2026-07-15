"""graphrag — Vector/Graph DB · 검색 (담당 C: 용하).

integration 계층(D)이 소비하는 공개 API:

    from neo4j import GraphDatabase
    from backend.graphrag import GraphStore, VectorStore, HybridSearch, timeline, meetings_by_topic

    driver = GraphDatabase.driver(uri, auth=(user, pw))
    gs, vs = GraphStore(driver), VectorStore()  # embed_fn 미지정 시 OpenAI text-embedding-3-small(임시, SUPABASE_DB_URL 필요)

    gs.load_intermediate(intermediate_format)          # STT 중간포맷 → Project·Meeting
    gs.load_chunks(pid, mid, chunks)                   # chunking 청크 → Chunk (+벡터)
    vs.add_chunks(pid, mid, chunks)
    gs.load_extraction(pid, mid, llm_extraction)       # → Topic·Decision·ActionItem

    HybridSearch(driver, vs).search(pid, "질문")        # 벡터 top-k → 그래프 확장 → 재정렬
    timeline(driver, pid)                              # 시간별  ·  meetings_by_topic(driver, pid, "주제")  맥락별
"""

from .graph_store import GraphStore
from .vector_store import VectorStore, hashing_embed, openai_embed
from .search import HybridSearch
from .queries import timeline, meetings_by_topic, decision_history

__all__ = ["GraphStore", "VectorStore", "hashing_embed", "openai_embed", "HybridSearch",
           "timeline", "meetings_by_topic", "decision_history"]
