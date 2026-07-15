from __future__ import annotations

import os
import sys
import tempfile
import types
import importlib.util
import base64
import hashlib
import hmac
import json
import re
import secrets
import zipfile
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, EmailStr

from .auth import require_user

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
_auth_schema_ready = False
_auth_pool = None

app = FastAPI(title="SynapVox Integration API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def warm_auth_database() -> None:
    if os.getenv("SUPABASE_DB_URL"):
        _prepare_auth_database()


@app.on_event("shutdown")
def close_auth_pool() -> None:
    global _auth_pool
    if _auth_pool is not None:
        _auth_pool.closeall()
        _auth_pool = None


class SignupPayload(BaseModel):
    name: str
    email: EmailStr
    password: str


class LoginPayload(BaseModel):
    identifier: str
    password: str


class LogoutPayload(BaseModel):
    token: Optional[str] = None


def _load_psycopg2():
    try:
        import psycopg2
        from psycopg2.pool import SimpleConnectionPool
        from psycopg2.extras import RealDictCursor
        from psycopg2.errors import UniqueViolation
    except ModuleNotFoundError as exc:
        raise HTTPException(status_code=503, detail="database driver is not installed.") from exc
    return psycopg2, SimpleConnectionPool, RealDictCursor, UniqueViolation


def _get_auth_pool():
    global _auth_pool
    if _auth_pool is not None:
        return _auth_pool
    dsn = os.getenv("SUPABASE_DB_URL")
    if not dsn:
        raise HTTPException(status_code=503, detail="SUPABASE_DB_URL is required for auth.")
    _, SimpleConnectionPool, _, _ = _load_psycopg2()
    max_connections = int(os.getenv("AUTH_DB_POOL_MAX", "4"))
    _auth_pool = SimpleConnectionPool(1, max(1, max_connections), dsn)
    return _auth_pool


@contextmanager
def _auth_connection():
    pool = _get_auth_pool()
    conn = pool.getconn()
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.rollback()
        pool.putconn(conn)


def _prepare_auth_database() -> None:
    with _auth_connection() as conn:
        _ensure_auth_schema(conn)


def _ensure_auth_schema(conn) -> None:
    global _auth_schema_ready
    if _auth_schema_ready:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS app_users (
                id UUID PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                expires_at TIMESTAMPTZ NOT NULL
            );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);")
        cur.execute("CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions (expires_at);")
    conn.commit()
    _auth_schema_ready = True


def _password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    iterations = 210_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt, digest = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        expected = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64.b64decode(salt),
            int(iterations),
        )
        return hmac.compare_digest(expected, base64.b64decode(digest))
    except Exception:
        return False


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _public_user(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["display_name"],
        "role": row["role"],
    }


def _create_session(conn, user_id: str) -> dict:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)",
            (_hash_token(token), user_id, expires_at),
        )
    conn.commit()
    return {"token": token, "expiresAt": expires_at.isoformat()}


def _signup_user(payload: SignupPayload) -> dict:
    name = payload.name.strip()
    email = payload.email.lower().strip()
    password = payload.password
    if len(name) < 1:
        raise HTTPException(status_code=400, detail="이름을 입력해주세요.")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="비밀번호는 6자 이상이어야 합니다.")

    _, _, RealDictCursor, UniqueViolation = _load_psycopg2()
    with _auth_connection() as conn:
        _ensure_auth_schema(conn)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    INSERT INTO app_users (id, email, display_name, password_hash)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id, email, display_name, role
                    """,
                    (str(uuid4()), email, name, _password_hash(password)),
                )
                user = dict(cur.fetchone())
            session = _create_session(conn, str(user["id"]))
        except UniqueViolation as exc:
            conn.rollback()
            raise HTTPException(status_code=409, detail="이미 가입된 이메일입니다.") from exc
    return {"user": _public_user(user), "session": session}


def _login_user(payload: LoginPayload) -> dict:
    identifier = payload.identifier.lower().strip()
    if not identifier or not payload.password:
        raise HTTPException(status_code=400, detail="아이디와 비밀번호를 입력해주세요.")

    _, _, RealDictCursor, _ = _load_psycopg2()
    with _auth_connection() as conn:
        _ensure_auth_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, email, display_name, password_hash, role
                FROM app_users
                WHERE email = %s
                """,
                (identifier,),
            )
            user = cur.fetchone()
        if user is None or not _verify_password(payload.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")
        session = _create_session(conn, str(user["id"]))
    return {"user": _public_user(dict(user)), "session": session}


def _logout_user(payload: LogoutPayload) -> dict:
    if not payload.token:
        return {"ok": True}
    with _auth_connection() as conn:
        _ensure_auth_schema(conn)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM auth_sessions WHERE token_hash = %s", (_hash_token(payload.token),))
        conn.commit()
    return {"ok": True}


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


@app.post("/api/auth/signup")
async def signup(payload: SignupPayload) -> dict:
    return await run_in_threadpool(_signup_user, payload)


@app.post("/api/auth/login")
async def login(payload: LoginPayload) -> dict:
    return await run_in_threadpool(_login_user, payload)


@app.post("/api/auth/logout")
async def logout(payload: LogoutPayload) -> dict:
    return await run_in_threadpool(_logout_user, payload)


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
