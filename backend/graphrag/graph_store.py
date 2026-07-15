"""GraphStore — Neo4j 적재 로직 (graphrag Baseline: Graph DB 스키마 구현·적재).

입력 계약:
- intermediate_format (stt 소유, schemas/intermediate_format.schema.json)  → Project·Meeting
- chunk 목록 (chunking 산출)                                              → Chunk (+HAS_CHUNK, 벡터 참조)
- llm_extraction (chunking 소유, schemas/llm_extraction.schema.json)       → Topic·Decision·ActionItem (+엣지)

모든 노드는 (project_id, <key>)로 MERGE → 재적재 멱등. FOLLOWS는 회의 date 순서로 연결.
"""

from . import schema as S


class GraphStore:
    def __init__(self, driver, database: str | None = None):
        self.driver = driver
        self.database = database
        S.apply_schema(driver, database)

    def _session(self):
        return self.driver.session(database=self.database)

    # ── 적재 ────────────────────────────────────────────
    def load_intermediate(self, im: dict) -> str:
        """STT 중간포맷 → Project + Meeting 노드. meeting_id 반환."""
        pid, mid = im["project_id"], im["meeting_id"]
        title = im.get("title") or mid
        summary = im.get("summary", "")
        source_type = im.get("source_type") or "transcript"
        preserve_existing = bool(im.get("preserve_existing"))
        with self._session() as s:
            s.run(
                f"MERGE (p:{S.PROJECT} {{project_id:$pid}}) "
                f"MERGE (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
                f"SET m.date=CASE WHEN $preserve AND m.date IS NOT NULL THEN m.date ELSE $date END, "
                f"m.title=CASE WHEN $preserve AND m.title IS NOT NULL THEN m.title ELSE $title END, "
                f"m.summary=CASE WHEN $preserve AND m.summary IS NOT NULL THEN m.summary ELSE $summary END, "
                f"m.source_type=CASE WHEN $preserve AND m.source_type IS NOT NULL THEN m.source_type ELSE $source_type END "
                f"MERGE (p)-[:{S.HAS_MEETING}]->(m)",
                pid=pid, mid=mid, date=im.get("date"), title=title, summary=summary,
                source_type=source_type, preserve=preserve_existing)
        self._rebuild_follows(pid)
        return mid

    def load_chunks(self, project_id: str, meeting_id: str, chunks: list[dict]):
        """chunking 산출 청크 → Chunk 노드 + HAS_CHUNK. chunk = {chunk_id, source_type, raw_span, timestamps, text}."""
        with self._session() as s:
            for c in chunks:
                s.run(
                    f"MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
                    f"MERGE (c:{S.CHUNK} {{project_id:$pid, chunk_id:$cid}}) "
                    f"SET c.source_type=$st, c.raw_span=$span, c.timestamps=$ts, c.vector_ref=$cid, c.text=$text "
                    f"MERGE (m)-[:{S.HAS_CHUNK}]->(c)",
                    pid=project_id, mid=meeting_id, cid=c["chunk_id"], st=c.get("source_type"),
                    span=str(c.get("raw_span")), ts=str(c.get("timestamps")), text=c.get("text", ""))

    def load_extraction(self, project_id: str, meeting_id: str, ext: dict):
        """llm_extraction → Topic/Decision/ActionItem + DISCUSSES/DECIDED_IN/RAISED_IN/SUPERSEDES."""
        pid, cid = project_id, ext["chunk_id"]
        with self._session() as s:
            for t in ext.get("topics", []):
                s.run(
                    f"MERGE (tp:{S.TOPIC} {{project_id:$pid, topic_id:$tid}}) "
                    f"SET tp.name=$name, tp.aliases=$aliases "
                    f"WITH tp MATCH (c:{S.CHUNK} {{project_id:$pid, chunk_id:$cid}}) "
                    f"MERGE (c)-[:{S.DISCUSSES}]->(tp) "
                    f"WITH tp MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
                    f"MERGE (m)-[:{S.DISCUSSES}]->(tp)",
                    pid=pid, cid=cid, mid=meeting_id, tid=t["topic_id"], name=t["name"],
                    aliases=t.get("aliases", []))
            for d in ext.get("decisions", []):
                s.run(
                    f"MERGE (de:{S.DECISION} {{project_id:$pid, decision_id:$did}}) "
                    f"SET de.statement=$stmt, de.date=$date "
                    f"WITH de MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
                    f"MERGE (de)-[:{S.DECIDED_IN}]->(m)",
                    pid=pid, mid=meeting_id, did=d["decision_id"], stmt=d["statement"], date=d.get("date"))
                if d.get("supersedes"):
                    s.run(
                        f"MATCH (a:{S.DECISION} {{project_id:$pid, decision_id:$did}}), "
                        f"(b:{S.DECISION} {{project_id:$pid, decision_id:$sid}}) "
                        f"MERGE (a)-[:{S.SUPERSEDES}]->(b)",
                        pid=pid, did=d["decision_id"], sid=d["supersedes"])
            for a in ext.get("action_items", []):
                s.run(
                    f"MERGE (ai:{S.ACTION_ITEM} {{project_id:$pid, item_id:$iid}}) "
                    f"SET ai.task=$task, ai.assignee=$assignee, ai.due=$due "
                    f"WITH ai MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
                    f"MERGE (ai)-[:{S.RAISED_IN}]->(m)",
                    pid=pid, mid=meeting_id, iid=a["item_id"], task=a["task"],
                    assignee=a.get("assignee"), due=a.get("due"))

    def relate_topics(self, project_id, topic_id_a, topic_id_b):
        """Topic–Topic 연관 (RELATES_TO)."""
        with self._session() as s:
            s.run(
                f"MATCH (a:{S.TOPIC} {{project_id:$pid, topic_id:$ta}}), "
                f"(b:{S.TOPIC} {{project_id:$pid, topic_id:$tb}}) MERGE (a)-[:{S.RELATES_TO}]->(b)",
                pid=project_id, ta=topic_id_a, tb=topic_id_b)

    def _rebuild_follows(self, project_id):
        """회의 date 순서로 FOLLOWS 재구성 (시간별 정리의 축)."""
        with self._session() as s:
            s.run(f"MATCH (:{S.MEETING} {{project_id:$pid}})-[r:{S.FOLLOWS}]->() DELETE r", pid=project_id)
            s.run(
                f"MATCH (m:{S.MEETING} {{project_id:$pid}}) WITH m ORDER BY m.date, m.meeting_id "
                f"WITH collect(m) AS ms "
                f"UNWIND CASE WHEN size(ms) < 2 THEN [] ELSE range(0, size(ms)-2) END AS i "
                f"WITH ms[i] AS a, ms[i+1] AS b MERGE (a)-[:{S.FOLLOWS}]->(b)",
                pid=project_id)

    def reset(self, project_id):
        with self._session() as s:
            s.run("MATCH (n {project_id:$pid}) DETACH DELETE n", pid=project_id)

    def _prune_orphans(self, session, project_id: str):
        session.run(
            f"MATCH (m:{S.MEETING} {{project_id:$pid}})-[r:{S.DISCUSSES}]->(t:{S.TOPIC} {{project_id:$pid}}) "
            f"WHERE NOT EXISTS {{ MATCH (m)-[:{S.HAS_CHUNK}]->(:{S.CHUNK})-[:{S.DISCUSSES}]->(t) }} "
            "DELETE r",
            pid=project_id,
        )
        session.run(
            f"MATCH (t:{S.TOPIC} {{project_id:$pid}}) "
            f"WHERE NOT EXISTS {{ MATCH (:{S.CHUNK} {{project_id:$pid}})-[:{S.DISCUSSES}]->(t) }} "
            "DETACH DELETE t",
            pid=project_id,
        )
        session.run(
            f"MATCH (d:{S.DECISION} {{project_id:$pid}}) "
            f"WHERE NOT (d)-[:{S.DECIDED_IN}]->(:{S.MEETING}) DETACH DELETE d",
            pid=project_id,
        )
        session.run(
            f"MATCH (a:{S.ACTION_ITEM} {{project_id:$pid}}) "
            f"WHERE NOT (a)-[:{S.RAISED_IN}]->(:{S.MEETING}) DETACH DELETE a",
            pid=project_id,
        )

    def delete_meeting(self, project_id: str, meeting_id: str) -> int:
        """Delete one recording/session and all graph nodes owned by its chunks."""
        with self._session() as s:
            record = s.run(
                f"MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
                f"OPTIONAL MATCH (m)-[:{S.HAS_CHUNK}]->(c:{S.CHUNK}) "
                "RETURN count(DISTINCT c) AS chunks",
                pid=project_id,
                mid=meeting_id,
            ).single()
            deleted = int(record["chunks"] if record else 0)
            s.run(
                f"MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}})-[:{S.HAS_CHUNK}]->(c:{S.CHUNK}) "
                "DETACH DELETE c",
                pid=project_id,
                mid=meeting_id,
            )
            s.run(
                f"MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) DETACH DELETE m",
                pid=project_id,
                mid=meeting_id,
            )
            self._prune_orphans(s, project_id)
        self._rebuild_follows(project_id)
        return deleted

    def delete_chunks_by_prefix(self, project_id: str, chunk_prefix: str) -> int:
        """Delete one document's chunks while preserving other sources in the same meeting."""
        with self._session() as s:
            record = s.run(
                f"MATCH (m:{S.MEETING} {{project_id:$pid}})-[:{S.HAS_CHUNK}]->"
                f"(c:{S.CHUNK} {{project_id:$pid}}) "
                "WHERE c.chunk_id STARTS WITH $prefix "
                "RETURN collect(DISTINCT m.meeting_id) AS meetings, count(DISTINCT c) AS chunks",
                pid=project_id,
                prefix=chunk_prefix,
            ).single()
            meeting_ids = list(record["meetings"] or []) if record else []
            deleted = int(record["chunks"] if record else 0)
            s.run(
                f"MATCH (c:{S.CHUNK} {{project_id:$pid}}) WHERE c.chunk_id STARTS WITH $prefix "
                "DETACH DELETE c",
                pid=project_id,
                prefix=chunk_prefix,
            )
            for meeting_id in meeting_ids:
                s.run(
                    f"MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
                    f"WHERE NOT (m)-[:{S.HAS_CHUNK}]->(:{S.CHUNK}) DETACH DELETE m",
                    pid=project_id,
                    mid=meeting_id,
                )
            self._prune_orphans(s, project_id)
        self._rebuild_follows(project_id)
        return deleted
