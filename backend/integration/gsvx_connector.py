"""SynapVox STT/material adapter for the self-hosted official Graphiti service.

STT intermediate JSON and document text are converted into Graphiti episodes.
Graphiti owns extraction, temporal fact search, and Neo4j persistence. This
adapter preserves the existing frontend contracts for graph data, details, and
grounded AI answers while scoping every operation by the project group_id.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import requests
from langsmith import traceable

# 이 파일은 로컬에서는 <repo>/backend/integration/gsvx_connector.py 지만, backend/ 를
# 배포 루트로 쓰는 환경(Railway 등)에서는 <container>/integration/gsvx_connector.py 로
# 놓인다. backend 디렉터리를 파일 위치 기준으로 고정해 두 레이아웃 모두에서 동작하게 한다.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# backend/stt/__init__.py는 stt팀 전용 의존성(kiwipiepy 등)을 끌어오므로, api/main.py의
# _load_stt_module과 같은 방식으로 패키지 스텁만 등록해 __init__ 실행 없이 서브모듈을 쓴다.
_backend_pkg = sys.modules.setdefault("backend", types.ModuleType("backend"))
_backend_pkg.__path__ = [str(BACKEND_ROOT)]
_stt_pkg = sys.modules.setdefault("backend.stt", types.ModuleType("backend.stt"))
_stt_pkg.__path__ = [str(BACKEND_ROOT / "stt")]

from backend.integration.pipeline import chunk_document, chunk_transcript, extract_text  # noqa: E402
from backend.observability import wrap_openai_client  # noqa: E402
from backend.stt.stt_normalizer import validate  # noqa: E402

# gsvx /ingest-text 본문 상한은 50,000자(_MAX_TEXT_CHARS, 초과 시 413) — 여유를 두고 자른다.
# 48,000자 ≈ 수 시간 분량 회의 전사라, 실제로는 대부분 분할 없이 한 번에 들어간다.
GSVX_TEXT_LIMIT = 48_000
# 상한을 넘어 어쩔 수 없이 나눌 때, 직전 파트의 끝을 다음 파트 앞에 겹쳐 넣는 길이 —
# 경계에 걸린 개념·관계가 양쪽 어디에서든 온전한 맥락으로 추출되게 한다.
SPLIT_OVERLAP = 1_000

DEFAULT_BASE_URL = "http://127.0.0.1:8020"
DEFAULT_API_KEY = ""
DEFAULT_ANSWER_MODEL = "gpt-4o-mini"
DEFAULT_GRAPHITI_CHUNK_CHARS = 48_000


# ── 변환: STT 중간포맷 → gsvx 입력 텍스트 ────────────────


def transcript_to_text(im: dict) -> str:
    """중간포맷 segments → '화자: 발화' 줄들 (pipeline.chunk_transcript와 동일 표기).

    gsvx는 타임스탬프·화자 필드를 따로 받지 않으므로, 화자는 줄 접두어로 텍스트에
    남기고 start/end는 버린다. Graphiti가 이 평문에서 개념·관계를 추출한다.
    """
    validate(im)
    return "\n".join(f"{seg['speaker']}: {seg['text']}" for seg in im["segments"])


def transcript_title(im: dict) -> str:
    """gsvx 세션(에피소드) 제목 — 그래프 뷰·타임라인에 그대로 표시된다."""
    source_name = Path(str(im.get("source") or "")).name.strip()
    if source_name:
        return source_name
    mode = "강의" if im.get("mode") == "lecture" else "회의"
    return f"{im['date']} {mode} 전사"


def document_title(stem: str, meeting_id: str | None = None) -> str:
    """자료(회의자료) 세션 제목. gsvx는 project(그룹 네임스페이스) 외에 meeting_id를 받는
    필드가 없으므로 — transcript_title과 같은 표기(끝에 괄호)로 제목에 붙여, 어떤 회의(음성
    파일)에 딸린 자료인지 그래프 뷰에서도 식별 가능하게 한다. meeting_id 없으면(프로젝트
    전역 자료) 기존과 동일하게 stem 그대로."""
    return f"{stem} ({meeting_id})" if meeting_id else stem


logger = logging.getLogger(__name__)


def _tag_langsmith_run(**metadata) -> None:
    """현재 LangSmith run에 추적 메타데이터(project_id 등)를 붙인다.

    추적이 꺼져 있거나 run 컨텍스트가 없으면 조용히 무시 — 관측은 본 기능을
    실패시키면 안 된다."""
    try:
        from langsmith.run_helpers import get_current_run_tree

        run = get_current_run_tree()
        values = {key: value for key, value in metadata.items() if value}
        if run is None or not values:
            return
        extra = getattr(run, "extra", None) or {}
        extra.setdefault("metadata", {}).update(values)
        run.extra = extra
    except Exception:  # noqa: BLE001
        pass


def source_metadata(kind: str, file: str, project: str | None,
                    meeting_id: str | None = None,
                    content_date: str | None = None) -> str:
    """에피소드 source_description에 넣는 추적 메타데이터(compact JSON).

    graphiti_host의 미팅 필터가 '"meeting_id":"<id>"' 부분 문자열 매칭으로 이 형식에
    의존하므로 separators(공백 없음)를 바꾸면 안 된다."""
    payload: dict = {"kind": kind, "file": file, "project_id": project, "meeting_id": meeting_id}
    if content_date:
        payload["date"] = content_date
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def split_for_ingest(text: str, limit: int = GSVX_TEXT_LIMIT,
                     overlap: int = SPLIT_OVERLAP) -> list[str]:
    """상한 이내면 분할 없이 통째로 1개 파트 — Graphiti가 내부에서 줄(화자 턴)별로 추출한다.

    상한(gsvx 하드 캡 50,000자, 초과 시 413)을 넘는 예외적인 경우에만 나누되,
    맥락 절단을 최소화한다:
      1. 문단(빈 줄) 경계 우선 — 회의자료처럼 문단 구조가 있는 문서는 문단에서 자른다
      2. 없으면 줄 경계 — 전사문은 줄 하나가 화자 턴이라 발화 중간이 잘리지 않는다
      3. 둘 다 없으면(하나의 초장문 줄) 강제 절단
    이어지는 파트는 직전 파트 끝 overlap자만큼(줄 경계 정렬)을 앞에 겹쳐 시작해,
    경계에 걸친 개념·관계가 어느 한쪽에서는 온전한 맥락으로 추출되게 한다.
    """
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []

    overlap = max(0, min(overlap, limit // 4))
    parts: list[str] = []
    pos = 0
    while pos < len(text):
        if len(text) - pos <= limit:
            parts.append(text[pos:].strip())
            break
        window = text[pos:pos + limit]
        # 파트가 최소 절반은 차도록, 절반 이후의 마지막 경계에서 자른다(파트 수 폭증 방지)
        cut = window.rfind("\n\n", limit // 2)
        if cut == -1:
            cut = window.rfind("\n", limit // 2)
        forced = cut == -1
        if forced:
            cut = limit
        parts.append(window[:cut].strip())
        # 다음 파트 시작점: 절단점에서 overlap만큼 되돌아간 줄 경계(없으면 문자 단위)
        back = text.rfind("\n", pos + cut - overlap, pos + cut)
        next_pos = back + 1 if back != -1 else pos + cut - (overlap if forced else 0)
        pos = max(next_pos, pos + 1)
        while pos < len(text) and text[pos] == "\n":
            pos += 1
    return [p for p in parts if p]


# ── gsvx HTTP 클라이언트 ─────────────────────────────────


class GsvxError(RuntimeError):
    """gsvx 호출 실패 — status_code는 HTTP 상태(연결 실패면 None), detail은 gsvx 메시지."""

    def __init__(self, status_code: int | None, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class GsvxClient:
    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 timeout: float = 300.0):
        # LLM 개념 추출이 도는 동안 gsvx가 응답을 잡고 있으므로 타임아웃은 넉넉히.
        self.base_url = (base_url or os.getenv("GSVX_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.api_key = api_key or os.getenv("GSVX_API_KEY") or DEFAULT_API_KEY
        self.timeout = timeout
        self.text_limit = GSVX_TEXT_LIMIT

    def _request(self, method: str, path: str, *, params: dict | None = None,
                 body: dict | None = None) -> dict:
        """Call the Graphiti service and normalize transport/API failures."""
        try:
            headers = {"X-API-Key": self.api_key} if self.api_key else {}
            resp = requests.request(
                method,
                f"{self.base_url}{path}",
                params=params,
                json=body,
                headers=headers,
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise GsvxError(None, f"Graphiti에 연결하지 못했습니다 ({self.base_url}): {exc}") from exc
        if resp.status_code >= 400:
            try:
                detail = (resp.json() or {}).get("detail")
            except ValueError:
                detail = None
            raise GsvxError(resp.status_code, detail or f"Graphiti {path} {resp.status_code}")
        try:
            return resp.json()
        except ValueError as exc:
            raise GsvxError(resp.status_code, f"Graphiti {path} 응답이 JSON이 아닙니다.") from exc

    def ingest_text(self, text: str, title: str, project: str | None = None,
                    name: str | None = None) -> dict:
        """공식 Graphiti `/messages`에 한 에피소드를 넣는다."""
        return self.ingest_texts([text], title, project=project, name=name)

    @traceable(name="Graphiti episode ingest", run_type="chain")
    def ingest_texts(self, texts: list[str], title: str, project: str | None = None,
                     name: str | None = None,
                     reference_time: datetime | None = None) -> dict:
        """여러 청크를 한 요청으로 보내 Graphiti의 벌크 적재 경로를 사용한다.

        reference_time을 주면 에피소드의 시간축 기준으로 쓴다(자료의 실제 날짜 등).
        생략 시 기존과 동일하게 적재 시각."""
        if not project:
            raise ValueError("Graphiti 적재에는 project(group_id)가 필요합니다.")
        texts = [text.strip() for text in texts if text.strip()]
        if not texts:
            raise ValueError("빈 텍스트는 그래프에 넣을 수 없습니다.")
        now = reference_time or datetime.now(timezone.utc)
        body = {
            "group_id": project,
            "messages": [{
                "name": title if len(texts) == 1 else f"{title} ({i + 1}/{len(texts)})",
                "role_type": "system",
                "role": "SynapVox",
                "content": text,
                "timestamp": (now + timedelta(milliseconds=i)).isoformat(),
                "source_description": name or "SynapVox 강의 자료",
            } for i, text in enumerate(texts)],
        }
        result = self._request("POST", "/messages", body=body)
        stats = result.get("stats") if isinstance(result.get("stats"), dict) else {}
        episodes = result.get("episodes") if isinstance(result.get("episodes"), list) else []
        counts = self._graph_counts(project)
        return {
            "session_key": str(episodes[0]) if episodes else "",
            "session_keys": [str(episode) for episode in episodes],
            "stats": {
                "concepts_total": counts["concepts"],
                "concepts_new": int(stats.get("concepts_new") or 0),
                "relations_new": int(stats.get("relations_new") or 0),
            },
            "accepted": bool(result.get("success", True)),
        }

    def graph(self, project: str) -> dict:
        with self._neo4j_driver() as driver:
            with driver.session(database=self._neo4j_database()) as session:
                nodes = session.run(
                    """MATCH (n) WHERE n.group_id = $project AND (n:Entity OR n:Episodic)
                       RETURN n.uuid AS id,
                              CASE WHEN n:Episodic THEN 'session' ELSE 'concept' END AS type,
                              coalesce(n.name, n.uuid) AS label,
                              {summary: n.summary, source: n.source_description,
                               created_at: toString(n.created_at)} AS meta""",
                    project=project,
                ).data()
                edges = session.run(
                    """MATCH (a)-[r]->(b)
                       WHERE a.group_id = $project AND b.group_id = $project
                         AND type(r) IN ['MENTIONS', 'RELATES_TO', 'NEXT_EPISODE']
                       RETURN a.uuid AS src, b.uuid AS dst,
                              CASE type(r)
                                WHEN 'MENTIONS' THEN 'SESSION_MENTIONS_CONCEPT'
                                WHEN 'NEXT_EPISODE' THEN 'NEXT_SESSION'
                                ELSE 'CONCEPT_RELATES_TO'
                              END AS rel_type,
                              CASE WHEN b:Entity THEN b.uuid ELSE null END AS concept_id,
                              CASE WHEN b:Entity THEN b.name ELSE null END AS concept_label,
                              1.0 AS weight""",
                    project=project,
                ).data()
        return {"nodes": nodes, "edges": edges}

    @traceable(name="SynapVox AI chat", run_type="chain")
    def ask(
        self,
        project: str,
        question: str,
        k: int = 6,
        meeting_id: str | None = None,
        history: list[dict] | None = None,
    ) -> dict:
        """meeting_id(선택)를 주면 graphiti_host의 /search가 이 미팅의 에피소드에서 나온
        사실로만 결과를 좁힌다 — group_id는 그대로 프로젝트 단위라 세션 간 엔티티 중복
        제거(dedup)는 안 깨진다(dedup은 group_id 스코프라서, 미팅별 group_id로 쪼개면
        같은 인물/개념이 회의마다 중복 생성됨 — 그래서 사후 필터링 방식을 씀)."""
        _tag_langsmith_run(project_id=project, meeting_id=meeting_id)
        facts, expansion = self._retrieve(project, question, k, meeting_id)
        answer = (
            self._answer_from_facts(question, facts, history=history)
            if history
            else self._answer_from_facts(question, facts)
        )
        return {
            "answer": answer,
            "hits": facts,
            "expansion": expansion,
        }

    @traceable(name="SynapVox AI chat (stream)", run_type="chain")
    def ask_stream(
        self,
        project: str,
        question: str,
        k: int = 6,
        meeting_id: str | None = None,
        history: list[dict] | None = None,
    ):
        """ask()의 스트리밍 버전 — {'type': 'delta', 'text'} 이벤트를 생성되는 대로 내고,
        마지막에 ask()와 동일한 페이로드의 {'type': 'complete', ...}를 낸다.
        검색·expansion은 스트리밍 전에 끝내므로 complete의 hits/expansion은 ask()와 같다."""
        _tag_langsmith_run(project_id=project, meeting_id=meeting_id)
        facts, expansion = self._retrieve(project, question, k, meeting_id)
        yield {"type": "status", "stage": "answering"}  # 검색 종료 → 생성 시작 신호
        parts: list[str] = []
        for piece in self._stream_answer_from_facts(question, facts, history=history):
            parts.append(piece)
            yield {"type": "delta", "text": piece}
        yield {
            "type": "complete",
            "answer": "".join(parts) or "답변을 생성하지 못했습니다.",
            "hits": facts,
            "expansion": expansion,
        }

    def _retrieve(self, project: str, question: str, k: int,
                  meeting_id: str | None) -> tuple[list[dict], dict]:
        body = {"group_ids": [project], "query": question, "max_facts": k}
        if meeting_id:
            body["meeting_id"] = meeting_id
        search = self._request("POST", "/search", body=body)
        facts = search.get("facts") if isinstance(search.get("facts"), list) else []
        return facts, self._expansion_for_facts(project, facts)

    def concept(self, project: str, concept_id: str) -> dict:
        with self._neo4j_driver() as driver:
            with driver.session(database=self._neo4j_database()) as session:
                record = session.run(
                    """MATCH (n:Entity {group_id: $project, uuid: $concept_id})
                       OPTIONAL MATCH (e:Episodic {group_id: $project})-[:MENTIONS]->(n)
                       RETURN n.uuid AS concept_id, n.name AS label, n.summary AS summary,
                              collect(DISTINCT {session_id: e.uuid, title: e.name}) AS sessions""",
                    project=project, concept_id=concept_id,
                ).single()
        if record is None:
            raise GsvxError(404, "개념을 찾지 못했습니다.")
        data = record.data()
        data["sessions"] = [
            item for item in data.get("sessions") or []
            if item.get("session_id") and item.get("title")
        ]
        return data

    def session(self, project: str, session_id: str) -> dict:
        with self._neo4j_driver() as driver:
            with driver.session(database=self._neo4j_database()) as session:
                record = session.run(
                    """MATCH (e:Episodic {group_id: $project, uuid: $session_id})
                       OPTIONAL MATCH (e)-[:MENTIONS]->(n:Entity)
                       RETURN e.uuid AS session_id, e.name AS title, e.content AS text,
                              collect(DISTINCT {concept_id: n.uuid, label: n.name}) AS concepts""",
                    project=project, session_id=session_id,
                ).single()
        if record is None:
            raise GsvxError(404, "세션을 찾지 못했습니다.")
        data = record.data()
        return {
            "session_id": session_id,
            "title": str(data.get("title") or ""),
            "text": str(data.get("text") or "").strip(),
            "concepts": [
                concept for concept in data.get("concepts") or []
                if concept.get("concept_id")
            ],
        }

    def reset(self, project: str) -> dict:
        return self._request("DELETE", f"/group/{quote(project, safe='')}")

    def delete_episode(self, episode_id: str) -> dict:
        return self._request("DELETE", f"/episode/{quote(episode_id, safe='')}")

    def delete_episodes(self, episode_ids: list[str]) -> dict:
        if not episode_ids:
            return {"success": True, "episodes_deleted": 0, "entities_deleted": 0}
        return self._request(
            "POST",
            "/episodes/delete",
            body={"episode_ids": list(dict.fromkeys(episode_ids))},
        )

    def prune_orphans(self, project: str) -> dict:
        return self._request(
            "DELETE",
            f"/group/{quote(project, safe='')}/orphans",
        )

    def find_episode_ids(self, project: str, *, meeting_id: str | None = None,
                         title: str | None = None) -> list[str]:
        """이전 적재 데이터의 episode ID를 녹음 ID 또는 원본 자료 제목으로 찾는다."""
        if not meeting_id and not title:
            return []
        with self._neo4j_driver() as driver:
            with driver.session(database=self._neo4j_database()) as session:
                rows = session.run(
                    """MATCH (e:Episodic {group_id: $project})
                       WHERE ($meeting_id <> '' AND e.name CONTAINS $meeting_marker)
                          OR ($title <> '' AND (e.name = $title OR e.name STARTS WITH $title_prefix))
                       RETURN DISTINCT e.uuid AS id""",
                    project=project,
                    meeting_id=meeting_id or "",
                    meeting_marker=f"({meeting_id})" if meeting_id else "",
                    title=title or "",
                    title_prefix=f"{title} (" if title else "",
                ).data()
        return [str(row["id"]) for row in rows if row.get("id")]

    @staticmethod
    def _neo4j_database() -> str:
        return os.getenv("NEO4J_DATABASE") or "neo4j"

    @staticmethod
    def _neo4j_driver():
        from neo4j import GraphDatabase

        uri = os.getenv("NEO4J_URI")
        user = os.getenv("NEO4J_USER") or os.getenv("NEO4J_USERNAME")
        password = os.getenv("NEO4J_PASSWORD")
        if not all((uri, user, password)):
            raise GsvxError(None, "Neo4j 환경변수가 설정되지 않았습니다.")
        return GraphDatabase.driver(uri, auth=(user, password))

    def _graph_counts(self, project: str) -> dict[str, int]:
        with self._neo4j_driver() as driver:
            with driver.session(database=self._neo4j_database()) as session:
                record = session.run(
                    """MATCH (n:Entity {group_id: $project})
                       WITH count(n) AS concepts
                       OPTIONAL MATCH (:Entity {group_id: $project})-[r:RELATES_TO]->
                                      (:Entity {group_id: $project})
                       RETURN concepts, count(r) AS relations""",
                    project=project,
                ).single()
        return {
            "concepts": int(record["concepts"] if record else 0),
            "relations": int(record["relations"] if record else 0),
        }

    def _expansion_for_facts(self, project: str, facts: list[dict]) -> dict:
        fact_ids = [str(f.get("uuid")) for f in facts if f.get("uuid")]
        for fact in facts:
            fact["node_ids"] = []
        if not fact_ids:
            return {"nodes": [], "edges": []}
        with self._neo4j_driver() as driver:
            with driver.session(database=self._neo4j_database()) as session:
                rows = session.run(
                    """MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
                       WHERE r.group_id = $project AND r.uuid IN $fact_ids
                       RETURN a.uuid AS src, a.name AS src_label,
                              b.uuid AS dst, b.name AS dst_label, r.uuid AS fact_id""",
                    project=project, fact_ids=fact_ids,
                ).data()
        nodes: dict[str, dict] = {}
        edges: list[dict] = []
        fact_nodes: dict[str, list[str]] = {}
        for row in rows:
            nodes[row["src"]] = {
                "id": row["src"], "type": "concept", "label": row["src_label"], "meta": {},
            }
            nodes[row["dst"]] = {
                "id": row["dst"], "type": "concept", "label": row["dst_label"], "meta": {},
            }
            edges.append({
                "src": row["src"], "dst": row["dst"], "rel_type": "CONCEPT_RELATES_TO",
                "concept_id": row["dst"], "concept_label": row["dst_label"], "weight": 1.0,
            })
            fact_nodes.setdefault(str(row["fact_id"]), []).extend([row["src"], row["dst"]])
        # 각 fact(hit)에 양끝 개념 노드 id를 붙인다 — 프론트 인용 칩이 세션 노드만이 아니라
        # 해당 fact의 개념 노드·엣지까지 강조할 수 있게 한다.
        for fact in facts:
            fact["node_ids"] = fact_nodes.get(str(fact.get("uuid")), [])
        return {"nodes": list(nodes.values()), "edges": edges}

    @staticmethod
    def _answer_messages(
        question: str,
        facts: list[dict],
        history: list[dict] | None = None,
    ) -> list[dict]:
        """답변 LLM에 보낼 messages 조립 — 동기(_answer_from_facts)·스트리밍 경로 공용."""
        # 근거에 번호와 출처를 붙여 증강 — 답변의 [n] 인용이 프론트에서 출처로 매핑된다.
        evidence = "\n".join(
            f"[{i + 1}]{GsvxClient._source_label(fact)} {fact.get('fact') or fact.get('name') or ''}"
            for i, fact in enumerate(facts)
        )
        prior_messages = [
            {"role": message["role"], "content": str(message.get("text") or "")}
            for message in (history or [])[-20:]
            if message.get("role") in {"user", "assistant"} and str(message.get("text") or "").strip()
        ]
        return [
            {
                "role": "system",
                "content": (
                    "당신은 대학 강의 학습 도우미입니다. 제공된 Graphiti 근거만 사용해 "
                    "한국어로 정확하게 답하세요. Markdown을 사용하고 수식은 인라인 $...$ 또는 "
                    "블록 $$...$$ LaTeX로 작성하세요. 근거가 부족하면 명확히 알리세요. "
                    "답변의 각 주장 끝에는 그 주장이 기반한 근거 번호를 [1], [2] 형식으로 표기하세요. "
                    "제공된 근거 번호 외의 번호를 만들어내지 마세요."
                ),
            },
            *prior_messages,
            {"role": "user", "content": f"질문: {question}\n\nGraphiti 근거:\n{evidence}"},
        ]

    @staticmethod
    @traceable(name="AI answer from Graphiti facts", run_type="chain")
    def _answer_from_facts(
        question: str,
        facts: list[dict],
        history: list[dict] | None = None,
    ) -> str:
        if not facts:
            return "현재 과목 자료에서 질문과 관련된 근거를 찾지 못했습니다."
        from openai import OpenAI

        client = wrap_openai_client(OpenAI(api_key=os.getenv("OPENAI_API_KEY")))
        response = client.chat.completions.create(
            model=os.getenv("GRAPHITI_ANSWER_MODEL") or DEFAULT_ANSWER_MODEL,
            temperature=0.2,
            messages=GsvxClient._answer_messages(question, facts, history),
        )
        return response.choices[0].message.content or "답변을 생성하지 못했습니다."

    @staticmethod
    def _stream_answer_from_facts(
        question: str,
        facts: list[dict],
        history: list[dict] | None = None,
    ):
        """_answer_from_facts의 스트리밍 버전 — 답변 텍스트 조각을 생성되는 대로 낸다."""
        if not facts:
            yield "현재 과목 자료에서 질문과 관련된 근거를 찾지 못했습니다."
            return
        from openai import OpenAI

        client = wrap_openai_client(OpenAI(api_key=os.getenv("OPENAI_API_KEY")))
        stream = client.chat.completions.create(
            model=os.getenv("GRAPHITI_ANSWER_MODEL") or DEFAULT_ANSWER_MODEL,
            temperature=0.2,
            messages=GsvxClient._answer_messages(question, facts, history),
            stream=True,
        )
        for chunk in stream:
            piece = chunk.choices[0].delta.content if chunk.choices else None
            if piece:
                yield piece

    @staticmethod
    def _source_label(fact: dict) -> str:
        """fact의 출처(에피소드 제목)를 근거 줄에 붙일 라벨로 만든다. 중복 제목은 한 번만."""
        titles = [s.get("title") for s in fact.get("sources") or [] if s.get("title")]
        unique = list(dict.fromkeys(titles))
        return f" (출처: {', '.join(unique)})" if unique else ""

    @traceable(name="STT transcript to Graphiti", run_type="chain")
    def ingest_transcript(self, im: dict, project: str | None = None) -> dict:
        """STT 중간포맷 dict → gsvx 세션(들). project 미지정 시 중간포맷의 project_id 사용.

        반환(요약): {chunks_ingested, concepts_total, concepts_new, relations_new, sessions}
        — 프론트 App.tsx가 기대하는 {chunks_ingested, concepts_total}를 포함한다.
        """
        validate(im)
        _tag_langsmith_run(
            project_id=project or im.get("project_id"), meeting_id=im.get("meeting_id"))
        started = time.perf_counter()
        # 중간포맷의 date(YYYY-MM-DD)를 에피소드 시간축으로 사용 — 자료의 content_date와
        # 동일한 규칙. 값이 없거나 형식이 어긋나면 기존과 동일하게 적재 시각.
        content_date = str(im.get("date") or "") or None
        reference_time = None
        if content_date:
            try:
                reference_time = datetime.fromisoformat(content_date).replace(tzinfo=timezone.utc)
            except ValueError:
                content_date = None
        max_chars = int(os.getenv("GRAPHITI_CHUNK_CHARS") or DEFAULT_GRAPHITI_CHUNK_CHARS)
        chunks = chunk_transcript(im, max_chars=max_chars)
        result = self._ingest_chunks(
            [chunk["text"] for chunk in chunks],
            transcript_title(im),
            project=project or im.get("project_id"),
            source_description=source_metadata(
                "transcript",
                transcript_title(im),
                project or im.get("project_id"),
                im["meeting_id"],
                content_date=content_date,
            ),
            reference_time=reference_time,
        )
        logger.info(
            "graphiti.ingest transcript project=%s meeting=%s chunks=%d elapsed=%.2fs",
            project or im.get("project_id"),
            im.get("meeting_id"),
            result.get("chunks_ingested", 0),
            time.perf_counter() - started,
        )
        return result

    def ingest_document(self, path: Path | str, project: str | None = None,
                        title: str | None = None, meeting_id: str | None = None) -> dict:
        """회의자료 파일(pdf/pptx/docx/md/txt) → 텍스트 추출 → gsvx 세션(들).

        meeting_id를 주면 특정 회의(음성 파일)에 딸린 자료로 스코프(document_title 참조),
        생략하면 프로젝트 전역 자료로 취급(기존 동작과 동일)."""
        path = Path(path)
        text = extract_text(path)
        if not text.strip():
            raise ValueError(f"텍스트를 추출하지 못했습니다 (지원: pdf/pptx/docx/md/txt): {path.name}")
        return self.ingest_document_text(text, title or path.stem, project=project, meeting_id=meeting_id)

    @traceable(name="Course material to Graphiti", run_type="chain")
    def ingest_document_text(self, text: str, title: str, project: str | None = None,
                             meeting_id: str | None = None,
                             content_date: str | None = None) -> dict:
        """이미 추출된 자료 평문 → gsvx 세션(들). API 릴레이(api/main.py)가 사용.

        content_date(YYYY-MM-DD, 사용자가 지정한 자료의 실제 날짜)를 주면 에피소드
        시간축(reference_time)으로 쓴다. 생략 시 기존과 동일하게 적재 시각."""
        _tag_langsmith_run(project_id=project, meeting_id=meeting_id)
        started = time.perf_counter()
        reference_time = (
            datetime.fromisoformat(content_date).replace(tzinfo=timezone.utc)
            if content_date
            else None
        )
        max_chars = int(os.getenv("GRAPHITI_CHUNK_CHARS") or DEFAULT_GRAPHITI_CHUNK_CHARS)
        chunks = chunk_document(text, title, max_chars=max_chars)
        result = self._ingest_chunks(
            [chunk["text"] for chunk in chunks],
            document_title(title, meeting_id),
            project=project,
            source_description=source_metadata(
                "document", title, project, meeting_id, content_date=content_date),
            reference_time=reference_time,
        )
        logger.info(
            "graphiti.ingest document title=%s project=%s meeting=%s chunks=%d elapsed=%.2fs",
            title,
            project,
            meeting_id,
            result.get("chunks_ingested", 0),
            time.perf_counter() - started,
        )
        return result

    def _ingest_chunks(
        self,
        chunks: list[str],
        title: str,
        project: str | None = None,
        source_description: str | None = None,
        reference_time: datetime | None = None,
    ) -> dict:
        if not chunks:
            raise ValueError("빈 텍스트는 그래프에 넣을 수 없습니다.")
        result = self.ingest_texts(
            chunks,
            title,
            project=project,
            name=source_description,
            reference_time=reference_time,
        )
        stats = result.get("stats", {})
        return {
            "chunks_ingested": len(chunks),
            "concepts_total": stats.get("concepts_total", 0),
            "concepts_new": stats.get("concepts_new", 0),
            "relations_new": stats.get("relations_new", 0),
            "sessions": result.get("session_keys", []),
        }


def _summarize(results: list[dict]) -> dict:
    """gsvx 응답들 → 프론트 계약({chunks_ingested, concepts_total}) 형태로 요약."""
    stats = [r.get("stats", {}) for r in results]
    return {
        "chunks_ingested": len(results),
        "concepts_total": stats[-1].get("concepts_total", 0),
        "concepts_new": sum(s.get("concepts_new", 0) for s in stats),
        "relations_new": sum(s.get("relations_new", 0) for s in stats),
        "sessions": [r.get("session_key") for r in results],
    }


# ── CLI ─────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> None:
    """CLI: python -m backend.integration.gsvx_connector 파일... [--project P01]

    중간포맷 JSON(segments+meeting_id 보유)은 전사문으로, 그 외 파일은 자료로 넣는다.
    """
    import argparse
    import json

    parser = argparse.ArgumentParser(description="STT 결과·회의자료 → gsvx(Graphiti) 적재")
    parser.add_argument("files", nargs="+")
    parser.add_argument("--project", help="gsvx 네임스페이스 (기본: 전사문의 project_id / 키 기본값)")
    parser.add_argument("--meeting-id", help="자료를 특정 회의(음성 파일)에 스코프 (전사문 JSON은 자체 meeting_id를 씀, 이 옵션 무시)")
    parser.add_argument("--base-url", help=f"gsvx 주소 (기본: $GSVX_BASE_URL 또는 {DEFAULT_BASE_URL})")
    parser.add_argument("--api-key", help="gsvx X-API-Key (기본: $GSVX_API_KEY 또는 데모 키)")
    args = parser.parse_args(argv)

    client = GsvxClient(base_url=args.base_url, api_key=args.api_key)
    for raw in args.files:
        path = Path(raw)
        result = None
        if path.suffix.lower() == ".json":
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                data = None
            if isinstance(data, dict) and "segments" in data and "meeting_id" in data:
                result = client.ingest_transcript(data, project=args.project)
        if result is None:
            result = client.ingest_document(path, project=args.project, meeting_id=args.meeting_id)
        print(f"{path.name}: 세션 {result['chunks_ingested']}개 적재, "
              f"신규 개념 {result['concepts_new']}개, 누적 개념 {result['concepts_total']}개")


if __name__ == "__main__":
    main()
