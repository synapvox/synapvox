"""Long-lived FastAPI host for the official Graphiti engine.

The upstream example server queues work after its request-scoped Graphiti client
has been closed. SynapVox keeps one client alive for the process lifetime and
waits for each ingestion to finish before acknowledging it.
"""

from __future__ import annotations

import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from graph_service.dto import AddMessagesRequest, SearchQuery
from graph_service.zep_graphiti import ZepGraphiti, get_fact_result_from_edge
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.errors import NodeNotFoundError
from graphiti_core.nodes import EpisodeType
from langsmith import traceable
from pydantic import BaseModel, Field

from backend.observability import wrap_openai_client

load_dotenv(Path(__file__).resolve().parents[2] / ".env")


class AcademicConcept(BaseModel):
    """An independently meaningful academic term, theory, or object taught in a course."""

    description: str | None = Field(None, description="Brief course-context definition")


class Method(BaseModel):
    """An algorithm, procedure, analysis method, or problem-solving technique."""

    purpose: str | None = Field(None, description="What the method is used for")


class Condition(BaseModel):
    """A mathematical assumption, constraint, requirement, or cause-and-effect condition."""

    effect: str | None = Field(None, description="The result when the condition holds")


class Formula(BaseModel):
    """A named equation, mathematical expression, theorem, or quantitative rule."""

    expression: str | None = Field(None, description="Formula or symbolic expression when present")


class EpisodeDeleteRequest(BaseModel):
    episode_ids: list[str] = Field(min_length=1, max_length=500)


ENTITY_TYPES: dict[str, type[BaseModel]] = {
    "AcademicConcept": AcademicConcept,
    "Method": Method,
    "Condition": Condition,
    "Formula": Formula,
}
logger = logging.getLogger(__name__)


def _settings() -> tuple[str, str, str]:
    uri = os.getenv("NEO4J_URI") or ""
    user = os.getenv("NEO4J_USER") or os.getenv("NEO4J_USERNAME") or ""
    password = os.getenv("NEO4J_PASSWORD") or ""
    if not all((uri, user, password)):
        raise RuntimeError("NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD are required")
    return uri, user, password


@asynccontextmanager
async def lifespan(app: FastAPI):
    uri, user, password = _settings()
    driver = Neo4jDriver(
        uri=uri,
        user=user,
        password=password,
        database=os.getenv("NEO4J_DATABASE") or "neo4j",
    )
    graphiti = ZepGraphiti(graph_driver=driver)
    if os.getenv("OPENAI_API_KEY"):
        graphiti.llm_client.config.api_key = os.environ["OPENAI_API_KEY"]
    graphiti.llm_client.model = os.getenv("GRAPHITI_MODEL") or "gpt-5-mini"
    graphiti.llm_client.client = wrap_openai_client(graphiti.llm_client.client)
    graphiti.embedder.client = wrap_openai_client(graphiti.embedder.client)
    graphiti.cross_encoder.client = wrap_openai_client(graphiti.cross_encoder.client)
    await graphiti.driver.health_check()
    await graphiti.build_indices_and_constraints()
    app.state.graphiti = graphiti
    yield
    await graphiti.close()


app = FastAPI(title="SynapVox Graphiti", lifespan=lifespan)

EXTRACTION_INSTRUCTIONS = """
이 입력은 대학 강의 녹음의 전사문 또는 강의 자료이다.
본문에 명시된 학습 가능한 전공 용어, 이론, 공식, 방법, 조건을 각각 독립된 엔티티로 빠짐없이 추출하고 이들 사이의 관계를 추출하라.
예를 들어 '경사하강법', '손실 함수', '기울기', '학습률', '수렴', '발산'은 서로 구분되는 개념이다.
문서 제목, 서비스명, 화자명, 단순 대명사와 의미가 약한 일반 동사는 엔티티로 추출하지 마라.
한국어 용어는 원문의 표기를 유지하고, 같은 개념의 한영 표기는 가능한 한 하나로 통합하라.
""".strip()


def _client() -> ZepGraphiti:
    return app.state.graphiti


@app.get("/healthcheck")
async def healthcheck() -> dict:
    await _client().driver.health_check()
    return {"status": "healthy"}


@app.post("/messages", status_code=201)
@traceable(name="Graphiti knowledge extraction", run_type="chain")
async def add_messages(request: AddMessagesRequest) -> dict:
    concepts_new = 0
    relations_new = 0
    episodes: list[str] = []
    for message in request.messages:
        result = await _client().add_episode(
            uuid=message.uuid,
            name=message.name,
            episode_body=message.content,
            source_description=message.source_description,
            reference_time=message.timestamp,
            source=EpisodeType.text,
            group_id=request.group_id,
            entity_types=ENTITY_TYPES,
            custom_extraction_instructions=EXTRACTION_INSTRUCTIONS,
        )
        logger.info(
            "graphiti.ingest completed group=%s model=%s episode=%s nodes=%d edges=%d",
            request.group_id,
            _client().llm_client.model,
            result.episode.uuid,
            len(result.nodes),
            len(result.edges),
        )
        episodes.append(result.episode.uuid)
        concepts_new += len(result.nodes)
        relations_new += len(result.edges)
    return {
        "success": True,
        "message": "Messages ingested",
        "episodes": episodes,
        "stats": {"concepts_new": concepts_new, "relations_new": relations_new},
    }


class SearchQueryWithMeeting(SearchQuery):
    """SearchQuery + meeting_id(선택). 공식 Graphiti search()는 group_id 단위로만 dedup을
    하므로(node_operations.py의 node_similarity_search가 [node.group_id]로만 후보를 찾음),
    미팅마다 group_id를 나누면 같은 인물/개념이 회의마다 중복 노드로 생기게 된다. 그래서 group_id는
    프로젝트 단위로 유지하고, 검색 결과를 에피소드 제목으로 사후 필터링하는 방식을 쓴다."""

    meeting_id: str | None = Field(default=None)


async def _episode_ids_for_meeting(episode_ids: set[str], meeting_id: str) -> set[str]:
    """주어진 에피소드 uuid 중 이 미팅 것만 골라낸다.

    새 전사 데이터는 원본 파일명을 화면 제목으로 쓰고 source_description에 meeting_id를
    저장한다. 기존 데이터와 녹음 연결 자료는 제목의 ``(meeting_id)`` 접미사도 지원한다.
    """
    if not episode_ids:
        return set()
    result = await _client().driver.execute_query(
        """MATCH (e:Episodic)
           WHERE e.uuid IN $ids
             AND (e.source_description = $description OR e.name ENDS WITH $suffix)
           RETURN e.uuid AS uuid""",
        ids=list(episode_ids),
        description=f"meeting:{meeting_id}",
        suffix=f"({meeting_id})",
    )
    return {record["uuid"] for record in result.records}


@app.post("/search")
@traceable(name="Graphiti fact search", run_type="retriever")
async def search(query: SearchQueryWithMeeting) -> dict:
    edges = await _client().search(
        group_ids=query.group_ids,
        query=query.query,
        num_results=query.max_facts,
    )
    if query.meeting_id:
        episode_ids = {episode_id for edge in edges for episode_id in edge.episodes}
        matching = await _episode_ids_for_meeting(episode_ids, query.meeting_id)
        edges = [edge for edge in edges if matching.intersection(edge.episodes)]
    return {"facts": [get_fact_result_from_edge(edge).model_dump(mode="json") for edge in edges]}


@app.delete("/group/{group_id}")
async def delete_group(group_id: str) -> dict:
    result = await _client().driver.execute_query(
        """MATCH (node {group_id: $group_id})
           WITH collect(node) AS nodes, count(node) AS deleted
           FOREACH (node IN nodes | DETACH DELETE node)
           RETURN deleted""",
        group_id=group_id,
    )
    deleted = int(result.records[0]["deleted"]) if result.records else 0
    return {"success": True, "nodes_deleted": deleted}


@app.delete("/episode/{episode_id}")
async def delete_episode(episode_id: str) -> dict:
    try:
        await _client().remove_episode(episode_id)
    except NodeNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Episode not found") from exc
    return {"success": True, "message": "Episode deleted"}


@app.post("/episodes/delete")
async def delete_episodes(request: EpisodeDeleteRequest) -> dict:
    """Delete several episodes and their now-unreferenced graph data in bulk."""
    episode_ids = list(dict.fromkeys(request.episode_ids))
    driver = _client().driver

    candidate_result = await driver.execute_query(
        """MATCH (episode:Episodic)
           WHERE episode.uuid IN $episode_ids
           OPTIONAL MATCH (episode)-[:MENTIONS]->(entity:Entity)
           RETURN count(DISTINCT episode) AS episodes,
                  collect(DISTINCT entity.uuid) AS entity_ids""",
        episode_ids=episode_ids,
    )
    if not candidate_result.records:
        return {"success": True, "episodes_deleted": 0, "entities_deleted": 0}
    record = candidate_result.records[0]
    episode_count = int(record["episodes"])
    entity_ids = [value for value in record["entity_ids"] if value]

    # Keep shared facts, but remove deleted episode ownership from Graphiti edges.
    await driver.execute_query(
        """MATCH ()-[relation:RELATES_TO]->()
           WHERE any(id IN coalesce(relation.episodes, []) WHERE id IN $episode_ids)
           SET relation.episodes = [id IN coalesce(relation.episodes, [])
                                    WHERE NOT id IN $episode_ids]
           WITH relation
           WHERE size(relation.episodes) = 0
           DELETE relation""",
        episode_ids=episode_ids,
    )
    await driver.execute_query(
        """MATCH (episode:Episodic)
           WHERE episode.uuid IN $episode_ids
           DETACH DELETE episode""",
        episode_ids=episode_ids,
    )
    orphan_result = await driver.execute_query(
        """MATCH (entity:Entity)
           WHERE entity.uuid IN $entity_ids
             AND NOT EXISTS { MATCH (:Episodic)-[:MENTIONS]->(entity) }
           WITH collect(entity) AS entities, count(entity) AS deleted
           FOREACH (entity IN entities | DETACH DELETE entity)
           RETURN deleted""",
        entity_ids=entity_ids,
    )
    entity_count = int(orphan_result.records[0]["deleted"]) if orphan_result.records else 0
    return {
        "success": True,
        "episodes_deleted": episode_count,
        "entities_deleted": entity_count,
    }


@app.delete("/group/{group_id}/orphans")
async def prune_group_orphans(group_id: str) -> dict:
    """Remove concepts no remaining episode in this project references."""
    result = await _client().driver.execute_query(
        """MATCH (n:Entity {group_id: $group_id})
           WHERE NOT EXISTS { MATCH (:Episodic)-[:MENTIONS]->(n) }
           WITH collect(n) AS orphans
           WITH orphans, size(orphans) AS deleted
           FOREACH (n IN orphans | DETACH DELETE n)
           RETURN deleted""",
        group_id=group_id,
    )
    deleted = int(result.records[0]["deleted"]) if result.records else 0
    return {"success": True, "entities_deleted": deleted}
