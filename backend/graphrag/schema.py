"""Neo4j 스키마 상수 + 제약/인덱스.

schemas/graph_vector_db.md (draft v0.1)의 노드/엣지를 코드로 고정한다.
스키마 변경은 소유자(graphrag) 제안 → 담당자 합의(CONTRIBUTING.md). 여기선 draft를 그대로 구현.
"""

# 노드 라벨
PROJECT, MEETING, CHUNK, DOCUMENT, TOPIC, DECISION, ACTION_ITEM = (
    "Project", "Meeting", "Chunk", "Document", "Topic", "Decision", "ActionItem")

# 엣지 타입
HAS_MEETING, FOLLOWS, HAS_CHUNK, USES_DOCUMENT, DISCUSSES = (
    "HAS_MEETING", "FOLLOWS", "HAS_CHUNK", "USES_DOCUMENT", "DISCUSSES")
DECIDED_IN, RAISED_IN, SUPERSEDES, RELATES_TO = (
    "DECIDED_IN", "RAISED_IN", "SUPERSEDES", "RELATES_TO")

# 노드별 고유키 (MERGE 기준). 모든 노드는 project_id로 스코프.
NODE_KEY = {
    PROJECT: "project_id", MEETING: "meeting_id", CHUNK: "chunk_id",
    DOCUMENT: "doc_id", TOPIC: "topic_id", DECISION: "decision_id", ACTION_ITEM: "item_id",
}

CONSTRAINTS = [
    f"CREATE CONSTRAINT {lbl.lower()}_key IF NOT EXISTS "
    f"FOR (n:{lbl}) REQUIRE (n.project_id, n.{key}) IS UNIQUE"
    for lbl, key in NODE_KEY.items() if lbl != PROJECT
] + [
    f"CREATE CONSTRAINT project_key IF NOT EXISTS FOR (n:{PROJECT}) REQUIRE n.project_id IS UNIQUE"
]


def apply_schema(driver, database: str | None = None):
    """제약/인덱스 생성 (idempotent)."""
    with driver.session(database=database) as s:
        for c in CONSTRAINTS:
            s.run(c)
