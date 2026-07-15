from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import types
import importlib.util
import json
import logging
import re
import zipfile
from datetime import date
from pathlib import Path
from time import perf_counter
from typing import Literal, Optional
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from .auth import require_user

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
load_dotenv(REPO_ROOT / ".env")
logger = logging.getLogger(__name__)


def _load_stt_module(module_name: str):
    backend_package = sys.modules.setdefault("backend", types.ModuleType("backend"))
    backend_package.__path__ = [str(REPO_ROOT / "backend")]
    stt_package = sys.modules.setdefault("backend.stt", types.ModuleType("backend.stt"))
    stt_package.__path__ = [str(REPO_ROOT / "backend" / "stt")]

    qualified_name = f"backend.stt.{module_name}"
    if qualified_name in sys.modules:
        return sys.modules[qualified_name]

    module_path = REPO_ROOT / "backend" / "stt" / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(qualified_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load STT module: {module_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[qualified_name] = module
    spec.loader.exec_module(module)
    return module


_normalizer = _load_stt_module("stt_normalizer")
validate = _normalizer.validate
wrap_segments = _normalizer.wrap_segments
app = FastAPI(title="SynapVox Integration API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _extension(filename: str | None, content_type: str | None) -> str:
    suffix = Path(filename or "").suffix
    if suffix:
        return suffix
    if content_type == "audio/mp4":
        return ".m4a"
    if content_type == "audio/mpeg":
        return ".mp3"
    if content_type == "audio/wav":
        return ".wav"
    if content_type == "video/mp4":
        return ".mp4"
    if content_type == "video/quicktime":
        return ".mov"
    return ".webm"


def _read_text_file(path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "cp949"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="ignore")


def _extract_docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as docx:
        xml = docx.read("word/document.xml").decode("utf-8", errors="ignore")
    text = re.sub(r"<[^>]+>", " ", xml)
    return re.sub(r"\s+", " ", text).strip()


def _extract_pdf_text(path: Path, describe_images: bool | None = None) -> str:
    try:
        pdf = _load_stt_module("pdf_extractor")
        if describe_images is None:
            # 이미지 설명은 임베디드 이미지마다 비전 LLM을 부른다(비용 + OPENAI_API_KEY
            # 필수 — 없으면 KeyError로 전체 추출이 실패해 0자가 된다). 키가 있을 때만
            # 켜고, 없으면 텍스트 전용으로 강등한다.
            describe_images = bool(os.getenv("OPENAI_API_KEY"))
        result = pdf.extract_pdf(str(path), describe_images=describe_images)
    except Exception:
        return ""

    pages = result.get("pages", []) if isinstance(result, dict) else []
    parts = []
    for page in pages:
        if isinstance(page, dict):
            parts.append(str(page.get("text", "")))
    return "\n".join(part for part in parts if part).strip()


def _extract_pptx_text(path: Path) -> str:
    try:
        ppt = _load_stt_module("ppt_extractor")
        result = ppt.extract_pptx(str(path))
    except Exception:
        return ""

    slides = result.get("slides", []) if isinstance(result, dict) else []
    parts = []
    for slide in slides:
        if isinstance(slide, dict):
            parts.append(str(slide.get("text", "")))
    return "\n".join(part for part in parts if part).strip()


def _extract_material_text(path: Path, filename: str | None, content_type: str | None,
                           describe_images: bool | None = None) -> str:
    suffix = Path(filename or path.name).suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json", ".srt", ".vtt"} or (content_type or "").startswith("text/"):
        return _read_text_file(path)
    if suffix == ".pdf":
        return _extract_pdf_text(path, describe_images=describe_images)
    if suffix in {".docx"}:
        return _extract_docx_text(path)
    if suffix in {".pptx"}:
        return _extract_pptx_text(path)
    return ""


def _join_material_texts(materials: list[tuple[Path, str | None, str | None]]) -> str | None:
    parts = []
    for path, filename, content_type in materials:
        text = _extract_material_text(path, filename, content_type)
        if text:
            parts.append(f"# {filename or path.name}\n{text}")
    if not parts:
        return None
    return "\n\n---\n\n".join(parts)[:24000]


def _dev_transcript(source: str, project_id: str, meeting_id: str) -> dict:
    data = {
        "source": source,
        "meeting_id": meeting_id,
        "project_id": project_id,
        "date": date.today().isoformat(),
        "mode": "meeting",
        "segments": [
            {
                "id": 0,
                "speaker": "A",
                "start": 0.0,
                "end": 5.6,
                "text": "녹음 파일이 업로드되었고 전사 파이프라인으로 전달되었습니다.",
            },
            {
                "id": 1,
                "speaker": "B",
                "start": 5.7,
                "end": 12.4,
                "text": "CLOVA Speech 환경변수가 설정되면 이 자리에 실제 전사 결과가 표시됩니다.",
            },
            {
                "id": 2,
                "speaker": "A",
                "start": 12.8,
                "end": 19.2,
                "text": "프론트엔드는 같은 중간 포맷 JSON을 받아 화자별 전사문으로 매핑합니다.",
            },
        ],
    }
    validate(data)
    return data


def _transcribe_with_clova(audio_path: str, source: str, project_id: str, meeting_id: str, material_text: str | None = None) -> dict:
    clova = _load_stt_module("stt_clova")

    if material_text and hasattr(clova, "transcribe_with_materials"):
        raw_result = clova.transcribe_with_materials(audio_path, material_text=material_text)
    else:
        raw_result = clova.transcribe(audio_path)
    data = wrap_segments(
        raw_result["segments"],
        source=source,
        date=date.today().isoformat(),
        project_id=project_id,
        meeting_id=meeting_id,
    )
    validate(data)
    if material_text and os.getenv("OPENAI_API_KEY"):
      try:
          refiner = _load_stt_module("refine_transcript")
          data = refiner.refine_transcript(data, material_text=material_text)
          data["refinement"] = {"enabled": True}
      except Exception as exc:
          data["refinement"] = {"enabled": False, "error": str(exc)}
    else:
        data["refinement"] = {"enabled": False, "reason": "missing material_text or OPENAI_API_KEY"}
    validate(data)
    return data


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/admin/quality")
def admin_quality() -> dict:
    """관리자 대시보드 '품질' 탭 — 실측 WER 벤치마크(정적 데이터, backend/stt/quality_report.py 참고)."""
    quality_report = _load_stt_module("quality_report")
    return {"rows": quality_report.get_quality_rows()}


@app.get("/api/admin/health")
def admin_health() -> dict:
    """관리자 대시보드 '시스템' 탭 — STT 의존성(CLOVA/OpenAI/Soniox) 설정 여부 체크.
    비용 때문에 라이브 핑이 아니라 환경변수 presence만 확인함(backend/stt/health.py 참고)."""
    stt_health = _load_stt_module("health")
    return {"rows": stt_health.check_stt_health()}


@app.post("/api/stt/transcribe")
async def transcribe_recording(
    audio: UploadFile = File(...),
    materials: list[UploadFile] = File(default=[]),
    project_id: str = Form("local-project"),
    meeting_id: str = Form("local-meeting"),
    user: dict = Depends(require_user),
) -> dict:
    if not audio.content_type or not (audio.content_type.startswith("audio/") or audio.content_type.startswith("video/")):
        raise HTTPException(status_code=400, detail="audio or video file is required")

    source_name = audio.filename or f"recording-{uuid4().hex}.webm"
    suffix = _extension(audio.filename, audio.content_type)
    temp_path = None
    material_paths: list[tuple[Path, str | None, str | None]] = []

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while chunk := await audio.read(1024 * 1024):
                temp_file.write(chunk)

        for material in materials:
            material_suffix = Path(material.filename or "").suffix or ".bin"
            with tempfile.NamedTemporaryFile(delete=False, suffix=material_suffix) as temp_material:
                material_path = Path(temp_material.name)
                while chunk := await material.read(1024 * 1024):
                    temp_material.write(chunk)
            material_paths.append((material_path, material.filename, material.content_type))

        material_text = _join_material_texts(material_paths)

        has_clova = bool(os.getenv("CLOVA_SPEECH_INVOKE_URL") and os.getenv("CLOVA_SPEECH_SECRET"))
        if not has_clova:
            raise HTTPException(
                status_code=503,
                detail="CLOVA Speech environment variables are required for transcription.",
            )
        if (os.getenv("CLOVA_SPEECH_SECRET") or "").startswith("http"):
            raise HTTPException(
                status_code=400,
                detail="CLOVA_SPEECH_SECRET must be X-CLOVASPEECH-API-KEY, not the invoke URL.",
            )

        return await run_in_threadpool(
            _transcribe_with_clova,
            temp_path,
            source_name,
            project_id,
            meeting_id,
            material_text,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"transcription failed: {exc}") from exc
    finally:
        if temp_path is not None:
            Path(temp_path).unlink(missing_ok=True)
        for material_path, _, _ in material_paths:
            material_path.unlink(missing_ok=True)


# ── 프로젝트 지식 그래프 — 문서/전사 → Neo4j → 조회/RAG ──

_neo4j_driver = None
_graph_store_instance = None
_vector_store_instance = None


def _graph_runtime():
    global _neo4j_driver, _graph_store_instance
    try:
        from neo4j import GraphDatabase
        from backend.graphrag import GraphStore
        if _neo4j_driver is None:
            _neo4j_driver = GraphDatabase.driver(
                os.environ["NEO4J_URI"],
                auth=(os.getenv("NEO4J_USERNAME") or os.getenv("NEO4J_USER") or "neo4j",
                      os.environ["NEO4J_PASSWORD"]),
            )
            _neo4j_driver.verify_connectivity()
        database = os.getenv("NEO4J_DATABASE") or "neo4j"
        if _graph_store_instance is None:
            _graph_store_instance = GraphStore(_neo4j_driver, database=database)
        return _neo4j_driver, _graph_store_instance, database
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"graph database is not configured: {exc}") from exc


def _vector_store():
    global _vector_store_instance
    if _vector_store_instance is None:
        from backend.graphrag import VectorStore
        _vector_store_instance = VectorStore()
    return _vector_store_instance


def _optional_vector_store():
    try:
        return _vector_store()
    except Exception:
        return None


def _owned_source_record(user_id: str, source_id: str) -> dict | None:
    """Read deletion metadata only when the authenticated user owns the source."""
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT id, project_id, recording_id, kind, original_name, source_payload
                   FROM public.project_sources
                   WHERE id = %s AND owner_id = %s""",
                (source_id, user_id),
            )
            row = cursor.fetchone()
    if row is None:
        return None
    return dict(zip(
        ("id", "project_id", "recording_id", "kind", "original_name", "source_payload"),
        row,
    ))


def _owned_project_record(user_id: str, project_id: str) -> dict | None:
    """Return a project only when it belongs to the authenticated user."""
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT id, name, trashed_at
                   FROM public.projects
                   WHERE id = %s AND owner_id = %s""",
                (project_id, user_id),
            )
            row = cursor.fetchone()
    if row is None:
        return None
    return dict(zip(("id", "name", "trashed_at"), row))


def _owned_trashed_project_ids(user_id: str, project_ids: list[str]) -> list[str]:
    """Return only requested projects that are owned by the user and in trash."""
    if not project_ids:
        return []
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT id FROM public.projects
                   WHERE owner_id = %s AND trashed_at IS NOT NULL AND id = ANY(%s)""",
                (user_id, project_ids),
            )
            return [str(row[0]) for row in cursor.fetchall()]


def _owned_transcript_exists(user_id: str, project_id: str, meeting_id: str) -> bool:
    """Only persisted, user-owned transcripts may be ingested into the graph."""
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT 1 FROM public.recording_transcripts
                   WHERE owner_id = %s AND project_id = %s AND meeting_id = %s
                   LIMIT 1""",
                (user_id, project_id, meeting_id),
            )
            return cursor.fetchone() is not None


ANSWER_INSTRUCTIONS = (
    "제공된 강의 자료와 전사문만 근거로 한국어로 간결하게 답하세요. "
    "근거가 부족하면 부족하다고 말하세요. 답변은 Markdown으로 구조화하고, "
    "수학 수식은 인라인 수식은 $...$, 블록 수식은 $$...$$ 형태의 LaTeX로 작성하세요."
)


class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=8000)


class AskStreamRequest(BaseModel):
    project: str = Field(min_length=1)
    q: str = Field(min_length=1, max_length=4000)
    k: int = Field(default=6, ge=1, le=12)
    history: list[ChatHistoryMessage] = Field(default_factory=list, max_length=30)


def _fallback_answer(hits: list[dict]) -> str:
    if not hits:
        return "아직 이 프로젝트에서 질문과 관련된 자료나 전사문을 찾지 못했습니다."
    return f"관련 자료에서 다음 내용을 확인했습니다.\n\n{hits[0].get('text', '')[:700]}"


def _answer_request(
    question: str,
    hits: list[dict],
    history: list[dict] | None = None,
) -> dict:
    context = "\n\n".join(
        f"[{hit.get('meeting_title') or hit.get('meeting_id') or '근거'}]\n{hit.get('text', '')}"
        for hit in hits
    )[:12000]
    history_text = "\n".join(
        f"{'사용자' if item.get('role') == 'user' else 'AI'}: {item.get('text', '')}"
        for item in (history or [])[-12:]
    )[-6000:]
    conversation = f"\n\n그동안의 대화:\n{history_text}" if history_text else ""
    return {
        "model": os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
        "instructions": ANSWER_INSTRUCTIONS,
        "input": (
            f"질문: {question}{conversation}\n\n근거:\n{context}\n\n"
            "이전 대화는 질문의 맥락을 이해하는 용도로만 사용하고, 사실 판단은 반드시 근거를 우선하세요."
        ),
        "max_output_tokens": int(os.getenv("OPENAI_CHAT_MAX_TOKENS", "900")),
        "store": False,
    }


def _stream_answer_text(question: str, hits: list[dict], history: list[dict] | None = None):
    if not hits or not os.getenv("OPENAI_API_KEY"):
        yield _fallback_answer(hits)
        return
    emitted = False
    if os.getenv("OPENAI_API_KEY"):
        try:
            with _chat_client().responses.stream(**_answer_request(question, hits, history)) as stream:
                for event in stream:
                    if event.type == "response.output_text.delta" and event.delta:
                        emitted = True
                        yield event.delta
        except Exception:
            logger.exception("OpenAI answer stream failed")
    if not emitted:
        yield _fallback_answer(hits)


def _answer_from_hits(question: str, hits: list[dict]) -> str:
    return "".join(_stream_answer_text(question, hits)).strip()


@app.post("/ingest-stt", include_in_schema=False)
@app.post("/api/ingest-stt")
async def ingest_stt_to_graph(
    transcript: dict,
    x_project_id: str | None = Header(None, alias="X-Project-Id"),
    user: dict = Depends(require_user),
) -> dict:
    """STT 중간포맷 JSON을 현재 프로젝트의 Neo4j 그래프에 적재한다."""
    try:
        validate(transcript)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid intermediate format: {exc}") from exc
    project_id = x_project_id or transcript.get("project_id")
    if not project_id:
        raise HTTPException(status_code=400, detail="X-Project-Id or transcript.project_id is required")
    meeting_id = str(transcript.get("meeting_id") or "")
    user_id = str(user.get("sub") or "")
    transcript_saved = await run_in_threadpool(
        _owned_transcript_exists, user_id, project_id, meeting_id)
    if not transcript_saved:
        raise HTTPException(
            status_code=409,
            detail="transcript must be saved before graph ingest",
        )
    try:
        from backend.integration.pipeline import ingest_intermediate
        _, graph_store, _ = _graph_runtime()
        result = await run_in_threadpool(
            ingest_intermediate, transcript, graph_store, _optional_vector_store(), project_id)
        logger.info(
            "STT graph ingest timings project=%s meeting=%s timings_ms=%s",
            project_id,
            meeting_id,
            result.get("timings_ms"),
        )
        return {
            "project": result["project_id"], "meeting": result["meeting_id"],
            "chunks_ingested": len(result["chunks"]), "concepts_new": len(result["topic_ids"]),
            "concepts_total": result.get("concepts_total", len(result["topic_ids"])),
            "relations_new": result["relations"],
            "timings_ms": result.get("timings_ms", {}),
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"graph ingest failed: {exc}") from exc


@app.post("/ingest-doc", include_in_schema=False)
@app.post("/api/ingest-doc")
async def ingest_doc_to_graph(
    file: UploadFile = File(...),
    x_project_id: str | None = Header(None, alias="X-Project-Id"),
    x_meeting_id: str | None = Header(None, alias="X-Meeting-Id"),
    x_source_id: str | None = Header(None, alias="X-Source-Id"),
    user: dict = Depends(require_user),
) -> dict:
    """자료 텍스트를 현재 프로젝트에 적재한다. X-Meeting-Id가 있으면 해당 녹음본에 연결한다."""
    if not x_project_id:
        raise HTTPException(status_code=400, detail="X-Project-Id is required")

    suffix = Path(file.filename or "").suffix or ".bin"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = Path(temp_file.name)
            while chunk := await file.read(1024 * 1024):
                temp_file.write(chunk)

        # 그래프 적재는 본문 텍스트만 필요 — PDF 이미지 설명(비전 LLM, 비용)은 끈다.
        text = _extract_material_text(temp_path, file.filename, file.content_type,
                                      describe_images=False)
        if not text.strip():
            raise HTTPException(
                status_code=415,
                detail="텍스트를 추출하지 못했습니다 (지원: pdf/pptx/docx/md/txt).",
            )

        title = Path(file.filename or "자료").stem or "자료"
        try:
            from backend.integration.pipeline import ingest_document_text
            _, graph_store, _ = _graph_runtime()
            if x_source_id:
                from functools import partial
                ingest = partial(
                    ingest_document_text,
                    text,
                    title,
                    x_project_id,
                    graph_store,
                    _optional_vector_store(),
                    x_meeting_id,
                    document_id=x_source_id,
                )
                result = await run_in_threadpool(ingest)
            else:
                result = await run_in_threadpool(
                    ingest_document_text, text, title, x_project_id, graph_store,
                    _optional_vector_store(), x_meeting_id)
            logger.info(
                "document graph ingest timings project=%s meeting=%s timings_ms=%s",
                x_project_id,
                result["meeting_id"],
                result.get("timings_ms"),
            )
            return {
                "project": result["project_id"], "meeting": result["meeting_id"], "title": title,
                "chunks_ingested": len(result["chunks"]), "concepts_new": len(result["topic_ids"]),
                "concepts_total": result.get("concepts_total", len(result["topic_ids"])),
                "relations_new": result["relations"],
                "timings_ms": result.get("timings_ms", {}),
            }
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"graph ingest failed: {exc}") from exc
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@app.delete("/api/source-graph")
async def delete_source_graph(
    source_id: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    """Delete the Neo4j and pgvector data belonging to one owned source."""
    user_id = str(user.get("sub") or "")
    source = await run_in_threadpool(_owned_source_record, user_id, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="source not found")

    project_id = source["project_id"]
    _, graph_store, _ = _graph_runtime()
    try:
        vector_store = _vector_store()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"vector database is not configured: {exc}") from exc
    if source["kind"] == "audio":
        payload = source.get("source_payload") or {}
        meeting_id = payload.get("graphMeetingId") if isinstance(payload, dict) else None
        if not meeting_id:
            meeting_id = source.get("recording_id") or source_id
            if meeting_id.startswith("recording-"):
                meeting_id = meeting_id.replace("recording-", "meeting-", 1)
        graph_deleted = await run_in_threadpool(graph_store.delete_meeting, project_id, meeting_id)
        vector_deleted = await run_in_threadpool(vector_store.delete_meeting, project_id, meeting_id)
        return {
            "source_id": source_id,
            "project_id": project_id,
            "meeting_id": meeting_id,
            "graph_chunks_deleted": graph_deleted,
            "vector_chunks_deleted": vector_deleted,
        }

    from backend.integration.pipeline import document_chunk_prefix
    chunk_prefix = document_chunk_prefix(project_id, source_id)
    graph_deleted = await run_in_threadpool(
        graph_store.delete_chunks_by_prefix, project_id, chunk_prefix)
    if graph_deleted == 0:
        title = Path(source["original_name"]).stem or source["original_name"]
        legacy_prefix = document_chunk_prefix(project_id, title)
        if legacy_prefix != chunk_prefix:
            chunk_prefix = legacy_prefix
            graph_deleted = await run_in_threadpool(
                graph_store.delete_chunks_by_prefix, project_id, chunk_prefix)
    vector_deleted = await run_in_threadpool(
        vector_store.delete_chunks_by_prefix, project_id, chunk_prefix)
    return {
        "source_id": source_id,
        "project_id": project_id,
        "chunk_prefix": chunk_prefix,
        "graph_chunks_deleted": graph_deleted,
        "vector_chunks_deleted": vector_deleted,
    }


@app.get("/api/graph")
async def get_project_graph(
    project: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    from backend.graphrag import graph_data
    driver, _, database = _graph_runtime()
    return await run_in_threadpool(graph_data, driver, project, database)


@app.get("/api/ask")
async def ask_project_graph(
    project: str = Query(..., min_length=1),
    q: str = Query(..., min_length=1),
    k: int = Query(6, ge=1, le=12),
    user: dict = Depends(require_user),
) -> dict:
    from backend.graphrag import HybridSearch, expansion_for_chunks
    driver, _, database = _graph_runtime()
    vector_store = _optional_vector_store()
    if vector_store is None:
        raise HTTPException(status_code=503, detail="vector search is not configured")
    started = perf_counter()
    hits = await run_in_threadpool(HybridSearch(driver, vector_store, database).search, project, q, k)
    searched = perf_counter()
    answer = await run_in_threadpool(_answer_from_hits, q, hits)
    answered = perf_counter()
    expansion = await run_in_threadpool(
        expansion_for_chunks,
        driver,
        project,
        [hit["chunk_id"] for hit in hits],
        database,
    )
    finished = perf_counter()
    timings = {
        "search": round((searched - started) * 1000),
        "answer": round((answered - searched) * 1000),
        "focus": round((finished - answered) * 1000),
        "total": round((finished - started) * 1000),
    }
    logger.info("ask timings project=%s query=%r timings_ms=%s", project, q[:80], timings)
    return {"answer": answer,
            "hits": hits, "expansion": expansion,
            "timings_ms": timings}


def _ndjson_event(event_type: str, **payload) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"


def _ask_stream_events(
    driver,
    vector_store,
    database,
    project: str,
    q: str,
    k: int,
    history: list[dict] | None = None,
):
    from backend.graphrag import HybridSearch, expansion_for_chunks

    started = perf_counter()
    try:
        hits = HybridSearch(driver, vector_store, database).search(project, q, k)
        searched = perf_counter()
        answer_parts: list[str] = []
        pending_delta = ""
        last_flush = perf_counter()
        first_flush = True
        for delta in _stream_answer_text(q, hits, history):
            answer_parts.append(delta)
            pending_delta += delta
            now = perf_counter()
            threshold = 16 if first_flush else 64
            if len(pending_delta) >= threshold or now - last_flush >= 0.05:
                yield _ndjson_event("delta", text=pending_delta)
                pending_delta = ""
                last_flush = now
                first_flush = False
        if pending_delta:
            yield _ndjson_event("delta", text=pending_delta)
        answered = perf_counter()
        answer = "".join(answer_parts).strip()
        expansion = expansion_for_chunks(
            driver,
            project,
            [hit["chunk_id"] for hit in hits],
            database,
        )
        finished = perf_counter()
        timings = {
            "search": round((searched - started) * 1000),
            "answer": round((answered - searched) * 1000),
            "focus": round((finished - answered) * 1000),
            "total": round((finished - started) * 1000),
        }
        logger.info("ask stream timings project=%s query=%r timings_ms=%s", project, q[:80], timings)
        yield _ndjson_event(
            "complete",
            answer=answer,
            hits=hits,
            expansion=expansion,
            timings_ms=timings,
        )
    except Exception as exc:
        logger.exception("ask stream failed project=%s query=%r", project, q[:80])
        yield _ndjson_event("error", message=str(exc))


@app.get("/api/ask-stream")
def ask_project_graph_stream(
    project: str = Query(..., min_length=1),
    q: str = Query(..., min_length=1),
    k: int = Query(6, ge=1, le=12),
    user: dict = Depends(require_user),
) -> StreamingResponse:
    driver, _, database = _graph_runtime()
    vector_store = _optional_vector_store()
    if vector_store is None:
        raise HTTPException(status_code=503, detail="vector search is not configured")
    return StreamingResponse(
        _ask_stream_events(driver, vector_store, database, project, q, k),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/ask-stream")
def ask_project_graph_stream_with_history(
    request: AskStreamRequest,
    user: dict = Depends(require_user),
) -> StreamingResponse:
    driver, _, database = _graph_runtime()
    vector_store = _optional_vector_store()
    if vector_store is None:
        raise HTTPException(status_code=503, detail="vector search is not configured")
    history = [message.model_dump() for message in request.history]
    return StreamingResponse(
        _ask_stream_events(
            driver,
            vector_store,
            database,
            request.project,
            request.q,
            request.k,
            history,
        ),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/concept/{concept_id}")
async def get_concept_detail(
    concept_id: str,
    project: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    from backend.graphrag import concept_detail
    driver, _, database = _graph_runtime()
    result = await run_in_threadpool(concept_detail, driver, project, concept_id, database)
    if result is None:
        raise HTTPException(status_code=404, detail="concept not found")
    return result


@app.get("/api/session/{meeting_id}")
async def get_session_detail(
    meeting_id: str,
    project: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    from backend.graphrag import session_detail
    driver, _, database = _graph_runtime()
    result = await run_in_threadpool(session_detail, driver, project, meeting_id, database)
    if result is None:
        raise HTTPException(status_code=404, detail="session not found")
    return result
