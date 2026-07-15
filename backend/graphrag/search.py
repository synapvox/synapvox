"""HybridSearch — Vector top-k → 그래프 이웃 확장 → 재정렬 (graphrag Baseline).

벡터로 관련 청크를 찾고, Neo4j에서 그 청크의 주제·회의·산출물을 확장해 맥락을 붙인 뒤,
'여러 회의에 걸친 공유 주제'(세션 간 연결)를 신호로 재정렬한다.
"""

from . import schema as S


class HybridSearch:
    def __init__(self, driver, vector_store, database: str | None = None):
        self.driver = driver
        self.vec = vector_store
        self.database = database

    def _expand(self, project_id, chunk_id):
        """청크 1-hop 확장: 주제·소속 회의."""
        with self.driver.session(database=self.database) as s:
            rec = s.run(
                f"MATCH (c:{S.CHUNK} {{project_id:$pid, chunk_id:$cid}}) "
                f"OPTIONAL MATCH (c)-[:{S.DISCUSSES}]->(t:{S.TOPIC}) "
                f"OPTIONAL MATCH (m:{S.MEETING})-[:{S.HAS_CHUNK}]->(c) "
                f"RETURN collect(DISTINCT t.name) AS topics, "
                f"       head(collect(DISTINCT m.meeting_id)) AS meeting_id, "
                f"       head(collect(DISTINCT m.title)) AS meeting_title",
                pid=project_id, cid=chunk_id).single()
            return (rec["topics"] or [], rec["meeting_id"], rec["meeting_title"]) if rec else ([], None, None)

    def search(self, project_id: str, query: str, k: int = 8) -> list[dict]:
        hits = self.vec.query(project_id, query, k=k)
        enriched = []
        for h in hits:
            topics, mid, mtitle = self._expand(project_id, h["chunk_id"])
            enriched.append({**h, "topics": topics, "meeting_id": mid or h.get("meeting_id"),
                             "meeting_title": mtitle})
        # 재정렬: 여러 히트가 공유하는 주제(회의를 가로지르는 맥락)에 가중
        topic_freq: dict[str, int] = {}
        for e in enriched:
            for t in e["topics"]:
                topic_freq[t] = topic_freq.get(t, 0) + 1
        for e in enriched:
            boost = 0.05 * sum(topic_freq[t] - 1 for t in e["topics"])
            e["rerank_score"] = round(e["score"] + boost, 4)
        enriched.sort(key=lambda e: e["rerank_score"], reverse=True)
        return enriched
