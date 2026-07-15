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
import time
import zipfile
from datetime import date
from pathlib import Path
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


def _extract_pptx_text(path: Path, describe_images: bool | None = None) -> str:
    try:
        ppt = _load_stt_module("ppt_extractor")
        if describe_images is None:
            describe_images = bool(os.getenv("OPENAI_API_KEY"))
        result = ppt.extract_pptx(str(path), describe_images=describe_images)
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
        return _extract_pptx_text(path, describe_images=describe_images)
    return ""


def _join_material_texts(materials: list[tuple[Path, str | None, str | None]]) -> str | None:
    parts = []
    for path, filename, content_type in materials:
        # 전사 시작 경로에서는 텍스트만 빠르게 읽는다. 이미지 설명은 파일마다 별도의
        # Vision 호출이 발생하므로 자료 그래프 적재 경로에서 따로 수행한다.
        text = _extract_material_text(path, filename, content_type, describe_images=False)
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

    clova_started = time.perf_counter()
    if material_text and hasattr(clova, "transcribe_with_materials"):
        raw_result = clova.transcribe_with_materials(audio_path, material_text=material_text)
    else:
        raw_result = clova.transcribe(audio_path)
    logger.info(
        "stt.clova completed project=%s meeting=%s elapsed=%.2fs segments=%d",
        project_id,
        meeting_id,
        time.perf_counter() - clova_started,
        len(raw_result.get("segments") or []),
    )
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
          refinement_started = time.perf_counter()
          data = refiner.refine_transcript(data, material_text=material_text)
          data["refinement"] = {
              "enabled": True,
              "model": refiner.refinement_model(),
          }
          logger.info(
              "stt.refinement completed project=%s meeting=%s model=%s elapsed=%.2fs",
              project_id,
              meeting_id,
              refiner.refinement_model(),
              time.perf_counter() - refinement_started,
          )
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

        material_started = time.perf_counter()
        material_text = _join_material_texts(material_paths)
        logger.info(
            "stt.materials extracted project=%s meeting=%s files=%d chars=%d elapsed=%.2fs",
            project_id,
            meeting_id,
            len(material_paths),
            len(material_text or ""),
            time.perf_counter() - material_started,
        )

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


# ── 프로젝트 지식 그래프 — Graphiti(gsvx) API relay ──


def _gsvx_client():
    from backend.integration.gsvx_connector import GsvxClient
    return GsvxClient()


def _graphiti_error(exc: Exception) -> HTTPException:
    from backend.integration.gsvx_connector import GsvxError
    if isinstance(exc, GsvxError):
        return HTTPException(status_code=exc.status_code or 502, detail=exc.detail)
    return HTTPException(status_code=502, detail=f"Graphiti request failed: {exc}")


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


def _owned_source_bundle_records(user_id: str, source: dict) -> list[dict]:
    """Return a recording and all recording-scoped materials, or one standalone material."""
    recording_id = source.get("recording_id")
    if not recording_id:
        return [source]
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT id, project_id, recording_id, kind, original_name, source_payload
                   FROM public.project_sources
                   WHERE owner_id = %s AND recording_id = %s""",
                (user_id, recording_id),
            )
            rows = cursor.fetchall()
    keys = ("id", "project_id", "recording_id", "kind", "original_name", "source_payload")
    return [dict(zip(keys, row)) for row in rows]


def _store_source_graph_episode_ids(user_id: str, source_id: str,
                                    episode_ids: list[str]) -> None:
    """Persist Graphiti episode ownership so source deletion can be exact."""
    if not episode_ids:
        return
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """UPDATE public.project_sources
                   SET source_payload = coalesce(source_payload, '{}'::jsonb)
                       || jsonb_build_object('graphEpisodeIds', %s::jsonb),
                       updated_at = now()
                   WHERE id = %s AND owner_id = %s""",
                (json.dumps(episode_ids), source_id, user_id),
            )


def _owned_recording_source_id(user_id: str, project_id: str,
                               meeting_id: str) -> str | None:
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT recording_id FROM public.recording_transcripts
                   WHERE owner_id = %s AND project_id = %s AND meeting_id = %s
                   LIMIT 1""",
                (user_id, project_id, meeting_id),
            )
            row = cursor.fetchone()
    return str(row[0]) if row else None


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


class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=8000)


class AskStreamRequest(BaseModel):
    project: str = Field(min_length=1)
    q: str = Field(min_length=1, max_length=4000)
    k: int = Field(default=6, ge=1, le=12)
    history: list[ChatHistoryMessage] = Field(default_factory=list, max_length=30)


class ProjectTrashRequest(BaseModel):
    trashed: bool


def _set_project_trashed(user_id: str, project_id: str, trashed: bool) -> dict | None:
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """UPDATE public.projects
                   SET trashed_at = CASE WHEN %s THEN now() ELSE NULL END,
                       updated_at = now()
                   WHERE id = %s AND owner_id = %s
                   RETURNING id, trashed_at""",
                (trashed, project_id, user_id),
            )
            row = cursor.fetchone()
    return None if row is None else {"id": row[0], "trashed": row[1] is not None}


def _delete_project_rows(user_id: str, project_id: str) -> list[str]:
    """Delete one owned project and return object-storage paths for client cleanup."""
    import psycopg2

    with psycopg2.connect(os.environ["SUPABASE_DB_URL"]) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT storage_path FROM public.project_sources
                   WHERE project_id = %s AND owner_id = %s""",
                (project_id, user_id),
            )
            storage_paths = [str(row[0]) for row in cursor.fetchall()]
            cursor.execute(
                "DELETE FROM public.recording_transcripts WHERE project_id = %s AND owner_id = %s",
                (project_id, user_id),
            )
            cursor.execute("SELECT to_regclass('public.chat_sessions')")
            if cursor.fetchone()[0] is not None:
                cursor.execute(
                    "DELETE FROM public.chat_sessions WHERE project_id = %s AND owner_id = %s",
                    (project_id, user_id),
                )
            cursor.execute(
                "DELETE FROM public.project_sources WHERE project_id = %s AND owner_id = %s",
                (project_id, user_id),
            )
            cursor.execute(
                "DELETE FROM public.projects WHERE id = %s AND owner_id = %s",
                (project_id, user_id),
            )
            if cursor.rowcount != 1:
                raise LookupError("project not found")
    return storage_paths


@app.patch("/api/projects/{project_id}/trash")
async def set_project_trash_state(
    project_id: str,
    request: ProjectTrashRequest,
    user: dict = Depends(require_user),
) -> dict:
    result = await run_in_threadpool(
        _set_project_trashed, str(user.get("sub") or ""), project_id, request.trashed)
    if result is None:
        raise HTTPException(status_code=404, detail="project not found")
    return result


@app.delete("/api/projects/{project_id}")
async def permanently_delete_project(
    project_id: str,
    user: dict = Depends(require_user),
) -> dict:
    user_id = str(user.get("sub") or "")
    project = await run_in_threadpool(_owned_project_record, user_id, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    if project["trashed_at"] is None:
        raise HTTPException(status_code=409, detail="휴지통으로 이동한 프로젝트만 영구 삭제할 수 있습니다.")

    try:
        await run_in_threadpool(_gsvx_client().reset, project_id)
    except Exception as exc:
        raise _graphiti_error(exc) from exc

    try:
        storage_paths = await run_in_threadpool(_delete_project_rows, user_id, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="project not found") from exc
    return {"id": project_id, "deleted": True, "storage_paths": storage_paths}


@app.post("/ingest-stt", include_in_schema=False)
@app.post("/api/ingest-stt")
async def ingest_stt_to_graph(
    transcript: dict,
    x_project_id: str | None = Header(None, alias="X-Project-Id"),
    user: dict = Depends(require_user),
) -> dict:
    """STT intermediate JSON -> Graphiti episode ingestion."""
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
        result = await run_in_threadpool(
            _gsvx_client().ingest_transcript, transcript, project_id)
        source_id = await run_in_threadpool(
            _owned_recording_source_id, user_id, project_id, meeting_id)
        if source_id:
            await run_in_threadpool(
                _store_source_graph_episode_ids,
                user_id,
                source_id,
                [str(value) for value in result.get("sessions", []) if value],
            )
        return {"project": project_id, "meeting": meeting_id, **result}
    except Exception as exc:
        raise _graphiti_error(exc) from exc


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
    user_id = str(user.get("sub") or "")
    if x_source_id:
        source = await run_in_threadpool(_owned_source_record, user_id, x_source_id)
        if source is None or source["project_id"] != x_project_id:
            raise HTTPException(status_code=404, detail="source not found")

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
            result = await run_in_threadpool(
                _gsvx_client().ingest_document_text,
                text,
                title,
                x_project_id,
                x_meeting_id,
            )
            if x_source_id:
                await run_in_threadpool(
                    _store_source_graph_episode_ids,
                    user_id,
                    x_source_id,
                    [str(value) for value in result.get("sessions", []) if value],
                )
            return {
                "project": x_project_id,
                "meeting": x_meeting_id,
                "source_id": x_source_id,
                "title": title,
                **result,
            }
        except Exception as exc:
            raise _graphiti_error(exc) from exc
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@app.delete("/api/source-graph")
async def delete_source_graph(
    source_id: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    """Delete every Graphiti episode owned by one source or recording bundle."""
    user_id = str(user.get("sub") or "")
    source = await run_in_threadpool(_owned_source_record, user_id, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="source not found")
    records = await run_in_threadpool(_owned_source_bundle_records, user_id, source)
    episode_ids: set[str] = set()
    client = _gsvx_client()
    meeting_ids: set[str] = set()
    for record in records:
        payload = record.get("source_payload") or {}
        if isinstance(payload, dict):
            episode_ids.update(
                str(value) for value in payload.get("graphEpisodeIds", []) if value
            )
            meeting_id = payload.get("graphMeetingId")
            if isinstance(meeting_id, str) and meeting_id:
                meeting_ids.add(meeting_id)

    # Compatibility for sources ingested before graphEpisodeIds was persisted.
    for meeting_id in meeting_ids:
        episode_ids.update(await run_in_threadpool(
            client.find_episode_ids,
            source["project_id"],
            meeting_id=meeting_id,
        ))
    for record in records:
        if record.get("kind") != "document":
            continue
        title = Path(str(record.get("original_name") or "자료")).stem
        episode_ids.update(await run_in_threadpool(
            client.find_episode_ids,
            source["project_id"],
            title=title,
        ))

    deleted = 0
    for episode_id in episode_ids:
        try:
            await run_in_threadpool(client.delete_episode, episode_id)
            deleted += 1
        except Exception as exc:
            from backend.integration.gsvx_connector import GsvxError
            if isinstance(exc, GsvxError) and exc.status_code == 404:
                continue
            raise _graphiti_error(exc) from exc
    return {"source_id": source_id, "episodes_deleted": deleted}


@app.get("/api/graph")
async def get_project_graph(
    project: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    try:
        return await run_in_threadpool(_gsvx_client().graph, project)
    except Exception as exc:
        raise _graphiti_error(exc) from exc


@app.get("/api/ask")
async def ask_project_graph(
    project: str = Query(..., min_length=1),
    q: str = Query(..., min_length=1),
    k: int = Query(6, ge=1, le=12),
    user: dict = Depends(require_user),
) -> dict:
    try:
        return await run_in_threadpool(_gsvx_client().ask, project, q, k)
    except Exception as exc:
        raise _graphiti_error(exc) from exc


def _ndjson_event(event_type: str, **payload) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"


def _ask_stream_events(project: str, q: str, k: int):
    """Adapt Graphiti's complete answer response to the frontend NDJSON contract."""
    try:
        result = _gsvx_client().ask(project, q, k)
        answer = str(result.get("answer") or "")
        for start in range(0, len(answer), 48):
            yield _ndjson_event("delta", text=answer[start:start + 48])
        yield _ndjson_event("complete", **result)
    except Exception as exc:
        logger.exception("Graphiti ask failed project=%s query=%r", project, q[:80])
        error = _graphiti_error(exc)
        yield _ndjson_event("error", message=error.detail)


@app.get("/api/ask-stream")
def ask_project_graph_stream(
    project: str = Query(..., min_length=1),
    q: str = Query(..., min_length=1),
    k: int = Query(6, ge=1, le=12),
    user: dict = Depends(require_user),
) -> StreamingResponse:
    return StreamingResponse(
        _ask_stream_events(project, q, k),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/ask-stream")
def ask_project_graph_stream_with_history(
    request: AskStreamRequest,
    user: dict = Depends(require_user),
) -> StreamingResponse:
    return StreamingResponse(
        _ask_stream_events(request.project, request.q, request.k),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/concept/{concept_id}")
async def get_concept_detail(
    concept_id: str,
    project: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    try:
        return await run_in_threadpool(_gsvx_client().concept, project, concept_id)
    except Exception as exc:
        raise _graphiti_error(exc) from exc


@app.get("/api/session/{meeting_id}")
async def get_session_detail(
    meeting_id: str,
    project: str = Query(..., min_length=1),
    user: dict = Depends(require_user),
) -> dict:
    try:
        return await run_in_threadpool(_gsvx_client().session, project, meeting_id)
    except Exception as exc:
        raise _graphiti_error(exc) from exc
