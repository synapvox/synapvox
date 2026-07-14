from __future__ import annotations

import os
import sys
import tempfile
import types
import importlib.util
import json
import re
import zipfile
from datetime import date
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
load_dotenv(REPO_ROOT / ".env")


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


def _extract_pdf_text(path: Path) -> str:
    try:
        pdf = _load_stt_module("pdf_extractor")
        result = pdf.extract_pdf(str(path))
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


def _extract_material_text(path: Path, filename: str | None, content_type: str | None) -> str:
    suffix = Path(filename or path.name).suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json", ".srt", ".vtt"} or (content_type or "").startswith("text/"):
        return _read_text_file(path)
    if suffix == ".pdf":
        return _extract_pdf_text(path)
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


@app.post("/api/stt/transcribe")
async def transcribe_recording(
    audio: UploadFile = File(...),
    materials: list[UploadFile] = File(default=[]),
    project_id: str = Form("local-project"),
    meeting_id: str = Form("local-meeting"),
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
