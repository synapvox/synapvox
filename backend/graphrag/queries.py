"""시간별·맥락별 조회 쿼리 (graphrag Baseline: 시간별/맥락별 정리의 축).

- timeline: FOLLOWS 축 (시간별 정리)
- meetings_by_topic: DISCUSSES 축 (맥락별 정리)
- decision_history: SUPERSEDES 체인 (결정 번복 이력)
"""

from . import schema as S


def timeline(driver, project_id: str, database: str | None = None) -> list[dict]:
    with driver.session(database=database) as s:
        rows = s.run(
            f"MATCH (m:{S.MEETING} {{project_id:$pid}}) "
            f"OPTIONAL MATCH (m)-[:{S.DISCUSSES}]->(t:{S.TOPIC}) "
            f"RETURN m.meeting_id AS meeting_id, m.date AS date, m.title AS title, "
            f"       m.summary AS summary, collect(DISTINCT t.name) AS topics "
            f"ORDER BY m.date, m.meeting_id", pid=project_id)
        return [r.data() for r in rows]


def meetings_by_topic(driver, project_id: str, topic_name: str, database: str | None = None) -> list[dict]:
    with driver.session(database=database) as s:
        rows = s.run(
            f"MATCH (m:{S.MEETING} {{project_id:$pid}})-[:{S.DISCUSSES}]->(t:{S.TOPIC}) "
            f"WHERE t.name=$name OR $name IN coalesce(t.aliases, []) "
            f"RETURN DISTINCT m.meeting_id AS meeting_id, m.date AS date, m.title AS title "
            f"ORDER BY m.date", pid=project_id, name=topic_name)
        return [r.data() for r in rows]


def decision_history(driver, project_id: str, database: str | None = None) -> list[dict]:
    with driver.session(database=database) as s:
        rows = s.run(
            f"MATCH (d:{S.DECISION} {{project_id:$pid}}) "
            f"OPTIONAL MATCH (d)-[:{S.SUPERSEDES}]->(prev:{S.DECISION}) "
            f"OPTIONAL MATCH (d)-[:{S.DECIDED_IN}]->(m:{S.MEETING}) "
            f"RETURN d.decision_id AS decision_id, d.statement AS statement, d.date AS date, "
            f"       prev.decision_id AS supersedes, m.meeting_id AS meeting_id "
            f"ORDER BY d.date", pid=project_id)
        return [r.data() for r in rows]


def graph_data(driver, project_id: str, database: str | None = None) -> dict:
    """현재 프로젝트의 Meeting/Topic을 프론트 그래프 계약으로 변환한다."""
    with driver.session(database=database) as s:
        nodes = s.run(
            f"MATCH (m:{S.MEETING} {{project_id:$pid}}) "
            "RETURN m.meeting_id AS id, 'session' AS type, coalesce(m.title,m.meeting_id) AS label, "
            "{date:m.date, source_type:m.source_type} AS meta "
            "UNION ALL "
            f"MATCH (t:{S.TOPIC} {{project_id:$pid}}) "
            "RETURN t.topic_id AS id, 'concept' AS type, coalesce(t.name,t.topic_id) AS label, {} AS meta",
            pid=project_id,
        ).data()
        edges = s.run(
            f"MATCH (m:{S.MEETING} {{project_id:$pid}})-[:{S.DISCUSSES}]->(t:{S.TOPIC} {{project_id:$pid}}) "
            "RETURN m.meeting_id AS src, t.topic_id AS dst, 'SESSION_MENTIONS_CONCEPT' AS rel_type, "
            "t.topic_id AS concept_id, t.name AS concept_label, 1.0 AS weight "
            "UNION ALL "
            f"MATCH (a:{S.TOPIC} {{project_id:$pid}})-[:{S.RELATES_TO}]->(b:{S.TOPIC} {{project_id:$pid}}) "
            "RETURN a.topic_id AS src, b.topic_id AS dst, 'CONCEPT_CO_OCCURS_WITH' AS rel_type, "
            "null AS concept_id, null AS concept_label, 1.0 AS weight "
            "UNION ALL "
            f"MATCH (a:{S.MEETING} {{project_id:$pid}})-[:{S.FOLLOWS}]->(b:{S.MEETING} {{project_id:$pid}}) "
            "RETURN a.meeting_id AS src, b.meeting_id AS dst, 'NEXT_SESSION' AS rel_type, "
            "null AS concept_id, null AS concept_label, 1.0 AS weight",
            pid=project_id,
        ).data()
    return {"nodes": nodes, "edges": edges}


def concept_detail(driver, project_id: str, concept_id: str, database: str | None = None) -> dict | None:
    with driver.session(database=database) as s:
        record = s.run(
            f"MATCH (t:{S.TOPIC} {{project_id:$pid, topic_id:$tid}}) "
            f"OPTIONAL MATCH (m:{S.MEETING} {{project_id:$pid}})-[:{S.DISCUSSES}]->(t) "
            "RETURN t.topic_id AS concept_id, t.name AS label, t.summary AS summary, "
            "collect(DISTINCT {session_id:m.meeting_id, title:coalesce(m.title,m.meeting_id)}) AS sessions",
            pid=project_id, tid=concept_id,
        ).single()
    return record.data() if record else None


def session_detail(driver, project_id: str, meeting_id: str, database: str | None = None) -> dict | None:
    with driver.session(database=database) as s:
        record = s.run(
            f"MATCH (m:{S.MEETING} {{project_id:$pid, meeting_id:$mid}}) "
            f"OPTIONAL MATCH (m)-[:{S.DISCUSSES}]->(t:{S.TOPIC}) "
            "WITH m, collect(DISTINCT {concept_id:t.topic_id, label:t.name}) AS concepts "
            f"OPTIONAL MATCH (m)-[:{S.HAS_CHUNK}]->(c:{S.CHUNK}) "
            "RETURN m.meeting_id AS session_id, coalesce(m.title,m.meeting_id) AS title, "
            "m.summary AS summary, concepts, collect(DISTINCT {text:c.text}) AS segments",
            pid=project_id, mid=meeting_id,
        ).single()
    return record.data() if record else None


def expansion_for_chunks(driver, project_id: str, chunk_ids: list[str],
                         database: str | None = None) -> dict:
    """HybridSearch 근거 청크의 세션/개념 서브그래프를 프론트 강조 형식으로 반환한다."""
    if not chunk_ids:
        return {"nodes": [], "edges": []}
    with driver.session(database=database) as s:
        rows = s.run(
            f"MATCH (m:{S.MEETING} {{project_id:$pid}})-[:{S.HAS_CHUNK}]->"
            f"(c:{S.CHUNK} {{project_id:$pid}})-[:{S.DISCUSSES}]->(t:{S.TOPIC} {{project_id:$pid}}) "
            "WHERE c.chunk_id IN $chunk_ids "
            "RETURN DISTINCT m.meeting_id AS session_id, coalesce(m.title,m.meeting_id) AS session_title, "
            "t.topic_id AS concept_id, t.name AS concept_label",
            pid=project_id, chunk_ids=chunk_ids,
        ).data()
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    for row in rows:
        sid, tid = row["session_id"], row["concept_id"]
        nodes[sid] = {"id": sid, "type": "session", "label": row["session_title"], "meta": {}}
        nodes[tid] = {"id": tid, "type": "concept", "label": row["concept_label"], "meta": {}}
        edges.append({"src": sid, "dst": tid, "rel_type": "SESSION_MENTIONS_CONCEPT"})
    return {"nodes": list(nodes.values()), "edges": edges}
