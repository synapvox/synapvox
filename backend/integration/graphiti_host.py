"""Long-lived FastAPI host for the official Graphiti engine.

The upstream example server queues work after its request-scoped Graphiti client
has been closed. SynapVox keeps one client alive for the process lifetime and
waits for each ingestion to finish before acknowledging it.
"""

from __future__ import annotations

import os
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from graph_service.dto import AddMessagesRequest, SearchQuery
from graph_service.zep_graphiti import ZepGraphiti, get_fact_result_from_edge
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.errors import GroupsEdgesNotFoundError, NodeNotFoundError
from graphiti_core.nodes import EpisodeType
from graphiti_core.utils.bulk_utils import RawEpisode
from pydantic import BaseModel, Field


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
async def add_messages(request: AddMessagesRequest) -> dict:
    concepts_new = 0
    relations_new = 0
    episodes: list[str] = []
    batch_size = max(1, int(os.getenv("GRAPHITI_BULK_BATCH_SIZE") or "8"))
    raw_episodes = [
        RawEpisode(
            uuid=None,
            name=message.name,
            content=message.content,
            reference_time=message.timestamp,
            source=EpisodeType.text,
            source_description=message.source_description,
        )
        for message in request.messages
    ]
    for start in range(0, len(raw_episodes), batch_size):
        batch_started = time.perf_counter()
        batch = raw_episodes[start:start + batch_size]
        result = await _client().add_episode_bulk(
            batch,
            group_id=request.group_id,
            entity_types=ENTITY_TYPES,
            custom_extraction_instructions=EXTRACTION_INSTRUCTIONS,
        )
        logger.info(
            "graphiti.ingest completed group=%s model=%s episodes=%d elapsed=%.2fs",
            request.group_id,
            _client().llm_client.model,
            len(batch),
            time.perf_counter() - batch_started,
        )
        episodes.extend(episode.uuid for episode in result.episodes)
        concepts_new += len(result.nodes)
        relations_new += len(result.edges)
    return {
        "success": True,
        "message": "Messages ingested",
        "episodes": episodes,
        "stats": {"concepts_new": concepts_new, "relations_new": relations_new},
    }


@app.post("/search")
async def search(query: SearchQuery) -> dict:
    edges = await _client().search(
        group_ids=query.group_ids,
        query=query.query,
        num_results=query.max_facts,
    )
    return {"facts": [get_fact_result_from_edge(edge).model_dump(mode="json") for edge in edges]}


@app.delete("/group/{group_id}")
async def delete_group(group_id: str) -> dict:
    try:
        await _client().delete_group(group_id)
    except GroupsEdgesNotFoundError:
        pass
    return {"success": True, "message": "Group deleted"}


@app.delete("/episode/{episode_id}")
async def delete_episode(episode_id: str) -> dict:
    try:
        await _client().remove_episode(episode_id)
    except NodeNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Episode not found") from exc
    return {"success": True, "message": "Episode deleted"}
