"""gsvx_connector — STT 산출물·회의자료를 gsvx(Graphiti) 그래프 엔진에 넘기는 커넥터.

■ 연결하는 두 계약
1) 입력: STT 중간포맷 (stt 소유, schemas/intermediate_format.schema.json)
     {source, meeting_id, project_id, date, mode,
      segments: [{id, speaker, start, end, text}, ...]}
   backend/stt/stt_normalizer.py의 merge()/wrap_segments()가 생성하고,
   /api/stt/transcribe 응답으로 프론트에도 그대로 내려간다.

2) 출력: gsvx(Graphiti) 엔진 (click6067-ship-it/synapVOX, gsvx/api.py)
   텍스트가 그래프로 들어가는 유일한 입구는 POST /ingest-text 하나다:
     헤더  X-API-Key: <키>               (key_map 멤버십 인증)
     바디  {"text": str,                 (필수, 최대 50,000자 — _MAX_TEXT_CHARS)
            "title": str,                (에피소드/세션 이름)
            "project": str,              (Graphiti group_id 네임스페이스, ASCII 슬러그)
            "name": str}                 (사람이 읽는 프로젝트 표시 이름, 선택)
   응답: {"session_key", "stats": {"segments", "mentions", "concepts_total",
          "concepts_new", "relations_new"}, "pipeline": [...]}
   이후는 gsvx 내부에서 Graphiti add_episode → OpenAI 개념·관계 추출 → Neo4j 적재.

■ 이 모듈이 하는 일 (둘 사이의 변환)
- 중간포맷 segments 배열 → "화자: 발화" 줄들을 이어붙인 평문 한 덩어리
  (화자·발화 순서 보존, start/end 타임스탬프는 gsvx가 받지 않으므로 버린다)
- 회의자료(pdf/pptx/docx/md/txt) → pipeline.extract_text로 평문 추출
- 50,000자 상한 초과분은 줄 경계로 분할해 "제목 (i/n)" 세션 여러 개로 나눠 넣는다
- project_id → gsvx project(group_id) 네임스페이스로 전달

사용 예:
    from backend.integration.gsvx_connector import GsvxClient
    client = GsvxClient()                       # GSVX_BASE_URL/GSVX_API_KEY 환경변수 사용
    client.ingest_transcript(intermediate_json) # STT 결과 → 그래프
    client.ingest_document("slides.pptx")       # 회의자료 → 그래프
"""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# backend/stt/__init__.py는 stt팀 전용 의존성(kiwipiepy 등)을 끌어오므로, api/main.py의
# _load_stt_module과 같은 방식으로 패키지 스텁만 등록해 __init__ 실행 없이 서브모듈을 쓴다.
_backend_pkg = sys.modules.setdefault("backend", types.ModuleType("backend"))
_backend_pkg.__path__ = [str(REPO_ROOT / "backend")]
_stt_pkg = sys.modules.setdefault("backend.stt", types.ModuleType("backend.stt"))
_stt_pkg.__path__ = [str(REPO_ROOT / "backend" / "stt")]

from backend.integration.pipeline import extract_text  # noqa: E402
from backend.stt.stt_normalizer import validate  # noqa: E402

# gsvx /ingest-text 본문 상한은 50,000자(_MAX_TEXT_CHARS, 초과 시 413) — 여유를 두고 자른다.
# 48,000자 ≈ 수 시간 분량 회의 전사라, 실제로는 대부분 분할 없이 한 번에 들어간다.
GSVX_TEXT_LIMIT = 48_000
# 상한을 넘어 어쩔 수 없이 나눌 때, 직전 파트의 끝을 다음 파트 앞에 겹쳐 넣는 길이 —
# 경계에 걸린 개념·관계가 양쪽 어디에서든 온전한 맥락으로 추출되게 한다.
SPLIT_OVERLAP = 1_000

DEFAULT_BASE_URL = "http://127.0.0.1:8020"
DEFAULT_API_KEY = "demo-bio"  # gsvx 공개 데모 키 (프론트 .env.example과 동일)


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
    mode = "강의" if im.get("mode") == "lecture" else "회의"
    return f"{im['date']} {mode} 전사 ({im['meeting_id']})"


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

    def ingest_text(self, text: str, title: str, project: str | None = None,
                    name: str | None = None) -> dict:
        """gsvx POST /ingest-text 1회 호출 — 계약은 모듈 docstring 참조."""
        body: dict = {"text": text, "title": title}
        if project:
            body["project"] = project
        if name:
            body["name"] = name
        try:
            resp = requests.post(f"{self.base_url}/ingest-text", json=body,
                                 headers={"X-API-Key": self.api_key}, timeout=self.timeout)
        except requests.RequestException as exc:
            raise GsvxError(None, f"gsvx에 연결하지 못했습니다 ({self.base_url}): {exc}") from exc
        if resp.status_code >= 400:
            try:
                detail = (resp.json() or {}).get("detail")
            except ValueError:
                detail = None
            raise GsvxError(resp.status_code, detail or f"gsvx /ingest-text {resp.status_code}")
        return resp.json()

    def ingest_transcript(self, im: dict, project: str | None = None) -> dict:
        """STT 중간포맷 dict → gsvx 세션(들). project 미지정 시 중간포맷의 project_id 사용.

        반환(요약): {chunks_ingested, concepts_total, concepts_new, relations_new, sessions}
        — 프론트 App.tsx가 기대하는 {chunks_ingested, concepts_total}를 포함한다.
        """
        text = transcript_to_text(im)
        return self._ingest_parts(text, transcript_title(im),
                                  project=project or im.get("project_id"))

    def ingest_document(self, path: Path | str, project: str | None = None,
                        title: str | None = None) -> dict:
        """회의자료 파일(pdf/pptx/docx/md/txt) → 텍스트 추출 → gsvx 세션(들)."""
        path = Path(path)
        text = extract_text(path)
        if not text.strip():
            raise ValueError(f"텍스트를 추출하지 못했습니다 (지원: pdf/pptx/docx/md/txt): {path.name}")
        return self.ingest_document_text(text, title or path.stem, project=project)

    def ingest_document_text(self, text: str, title: str,
                             project: str | None = None) -> dict:
        """이미 추출된 자료 평문 → gsvx 세션(들). API 릴레이(api/main.py)가 사용."""
        return self._ingest_parts(text, title, project=project)

    def _ingest_parts(self, text: str, title: str, project: str | None = None) -> dict:
        parts = split_for_ingest(text, self.text_limit)
        if not parts:
            raise ValueError("빈 텍스트는 그래프에 넣을 수 없습니다.")
        results = []
        for i, part in enumerate(parts):
            part_title = title if len(parts) == 1 else f"{title} ({i + 1}/{len(parts)})"
            results.append(self.ingest_text(part, part_title, project=project))
        return _summarize(results)


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
            result = client.ingest_document(path, project=args.project)
        print(f"{path.name}: 세션 {result['chunks_ingested']}개 적재, "
              f"신규 개념 {result['concepts_new']}개, 누적 개념 {result['concepts_total']}개")


if __name__ == "__main__":
    main()
