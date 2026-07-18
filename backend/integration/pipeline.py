"""pipeline.py — E2E 오케스트레이션 (integration 소유).

chunking 모듈 삭제(2026-07-15)에 따라, 입력 파일과 graphrag 적재 사이의 **중간 매개 함수**를
이 파일이 담당한다. 핵심 진입점은 `ingest_files()`:

    입력 파일들 (STT 중간포맷 JSON 전사문 · 회의자료 txt/md/pdf/docx/pptx ...)
      → 텍스트 추출 (`extract_text`)
      → 청크 분할 (`chunk_transcript` / `chunk_document`)
      → Graph DB 적재: GraphStore.load_intermediate → load_chunks (text 포함)
        (+ 선택적으로 VectorStore.add_chunks)

청크 계약은 graphrag가 가정한 `{chunk_id, source_type, raw_span, timestamps, text}`
(backend/graphrag/graph_store.py 참조). chunk_id는 입력에 대해 결정론적이라 재적재 멱등.

사용 예 (integration 계층):

    from neo4j import GraphDatabase
    from backend.graphrag import GraphStore
    from backend.integration.pipeline import ingest_files

    gs = GraphStore(GraphDatabase.driver(uri, auth=(user, pw)))
    result = ingest_files(["meeting.json", "slides.pptx"], project_id="P01",
                          meeting_id="M01", graph_store=gs)

graph_store 없이 호출하면 dry-run — 청크만 만들어 반환한다 (오프라인 테스트용).
"""

from __future__ import annotations

import json
import hashlib
import re
import sys
import zipfile
from datetime import date
from itertools import combinations
from pathlib import Path

# backend/ 를 배포 루트로 쓰는 환경에서도 동작하도록 backend 디렉터리를 파일 위치 기준으로 잡는다.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.stt.stt_normalizer import validate  # noqa: E402  (중간포맷 검증 — 스키마 소유자 stt)
from backend.stt.keyword_prompt import extract_keywords  # noqa: E402

TEXT_SUFFIXES = {".txt", ".md", ".csv", ".srt", ".vtt"}


# ── 1) 텍스트 추출 ──────────────────────────────────────


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
        from backend.stt.pdf_extractor import extract_pdf
        # describe_images=True(기본)는 임베디드 이미지마다 비전 LLM을 호출한다(비용 +
        # OPENAI_API_KEY 필수 — 없으면 KeyError로 통째로 실패해 0자가 됨). 그래프/청크
        # 적재는 본문 텍스트만 필요하므로 텍스트 전용으로 추출한다.
        pages = extract_pdf(str(path), describe_images=False).get("pages", [])
    except Exception:
        return ""
    return "\n".join(str(p.get("text", "")) for p in pages if isinstance(p, dict)).strip()


def _extract_pptx_text(path: Path) -> str:
    try:
        from backend.stt.ppt_extractor import extract_pptx
        slides = extract_pptx(str(path)).get("slides", [])
    except Exception:
        return ""
    return "\n".join(str(s.get("text", "")) for s in slides if isinstance(s, dict)).strip()


def extract_text(path: Path | str) -> str:
    """입력 파일 → 평문 텍스트. 지원 포맷 밖이면 빈 문자열."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return _read_text_file(path)
    if suffix == ".pdf":
        return _extract_pdf_text(path)
    if suffix == ".docx":
        return _extract_docx_text(path)
    if suffix == ".pptx":
        return _extract_pptx_text(path)
    return ""


def _load_intermediate_json(path: Path) -> dict | None:
    """JSON 파일이 STT 중간포맷이면 dict 반환, 아니면 None."""
    try:
        data = json.loads(_read_text_file(path))
    except (json.JSONDecodeError, OSError):
        return None
    if isinstance(data, dict) and "segments" in data and "meeting_id" in data:
        validate(data)
        return data
    return None


# ── 2) 청크 분할 ────────────────────────────────────────


def chunk_transcript(im: dict, max_chars: int = 800) -> list[dict]:
    """중간포맷 전사문 → 청크. 화자 전환·길이 기준으로 세그먼트를 묶는다.

    청크: {chunk_id, source_type: "transcript", raw_span: [첫 seg id, 끝 seg id],
           timestamps: [start, end], text: "화자: 발화\\n..."}
    """
    mid = im["meeting_id"]
    chunks: list[dict] = []
    buf: list[dict] = []

    def flush():
        if not buf:
            return
        chunks.append({
            "chunk_id": f"{mid}-t{len(chunks):03d}",
            "source_type": "transcript",
            "raw_span": [buf[0]["id"], buf[-1]["id"]],
            "timestamps": [buf[0]["start"], buf[-1]["end"]],
            "text": "\n".join(f"{s['speaker']}: {s['text']}" for s in buf),
        })
        buf.clear()

    size = 0
    for seg in im.get("segments", []):
        speaker_changed = buf and seg["speaker"] != buf[-1]["speaker"]
        if buf and (size + len(seg["text"]) > max_chars or (speaker_changed and size >= max_chars // 2)):
            flush()
            size = 0
        buf.append(seg)
        size += len(seg["text"])
    flush()
    return chunks


def chunk_document(text: str, doc_id: str, max_chars: int = 800) -> list[dict]:
    """회의자료 평문 → 청크. 빈 줄 기준 문단을 max_chars까지 그리디하게 묶고, 초과 문단은 강제 분할.

    청크: {chunk_id: "<doc_id>-d000", source_type: "document", raw_span: None, timestamps: None, text}
    """
    paragraphs: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        while len(para) > max_chars:
            paragraphs.append(para[:max_chars])
            para = para[max_chars:]
        if para:
            paragraphs.append(para)

    chunks: list[dict] = []
    buf: list[str] = []
    size = 0

    def flush():
        nonlocal size
        if not buf:
            return
        chunks.append({
            "chunk_id": f"{doc_id}-d{len(chunks):03d}",
            "source_type": "document",
            "raw_span": None,
            "timestamps": None,
            "text": "\n\n".join(buf),
        })
        buf.clear()
        size = 0

    for para in paragraphs:
        if buf and size + len(para) > max_chars:
            flush()
        buf.append(para)
        size += len(para)
    flush()
    return chunks


def _topic_id(project_id: str, name: str) -> str:
    digest = hashlib.sha1(f"{project_id}\x1f{name.strip().lower()}".encode("utf-8")).hexdigest()[:16]
    return f"topic-{digest}"


def _document_digest(project_id: str, title: str) -> str:
    return hashlib.sha1(f"{project_id}\x1f{title}".encode("utf-8")).hexdigest()[:16]


def document_chunk_prefix(project_id: str, title: str) -> str:
    """Return the deterministic chunk prefix used for one project document."""
    return f"doc-{_document_digest(project_id, title)}-d"


def extract_chunk_topics(project_id: str, chunk: dict, top_n: int = 7) -> dict:
    """기존 키워드 추출기를 llm_extraction 계약의 Topic 형태로 변환한다."""
    topics = [
        {"topic_id": _topic_id(project_id, name), "name": name, "aliases": []}
        for name in extract_keywords(chunk.get("text", ""), top_n=top_n)
    ]
    return {"chunk_id": chunk["chunk_id"], "topics": topics, "decisions": [], "action_items": []}


def ingest_intermediate(
    intermediate: dict,
    graph_store,
    vector_store=None,
    project_id: str | None = None,
    max_chars: int = 800,
) -> dict:
    """인메모리 STT 중간포맷을 기존 GraphStore/VectorStore 계약으로 적재한다."""
    validate(intermediate)
    data = {**intermediate, "project_id": project_id or intermediate["project_id"]}
    data["source_type"] = "transcript"
    pid, mid = data["project_id"], data["meeting_id"]
    data.setdefault("title", data.get("source") or mid)
    chunks = chunk_transcript(data, max_chars=max_chars)
    graph_store.load_intermediate(data)
    graph_store.load_chunks(pid, mid, chunks)
    if vector_store is not None:
        vector_store.add_chunks(pid, mid, chunks)
    topic_ids: set[str] = set()
    relation_count = 0
    for chunk in chunks:
        extraction = extract_chunk_topics(pid, chunk)
        graph_store.load_extraction(pid, mid, extraction)
        ids = [topic["topic_id"] for topic in extraction["topics"]]
        topic_ids.update(ids)
        for left, right in combinations(ids, 2):
            graph_store.relate_topics(pid, left, right)
            relation_count += 1
    return {"project_id": pid, "meeting_id": mid, "chunks": chunks,
            "topic_ids": sorted(topic_ids), "relations": relation_count, "loaded": True}


def ingest_document_text(
    text: str,
    title: str,
    project_id: str,
    graph_store,
    vector_store=None,
    meeting_id: str | None = None,
    max_chars: int = 800,
    document_id: str | None = None,
) -> dict:
    """이미 추출된 프로젝트 자료를 기존 적재 파이프라인으로 저장한다."""
    doc_digest = _document_digest(project_id, document_id or title)
    mid = meeting_id or f"document-{doc_digest}"
    intermediate = {
        "source": title,
        "project_id": project_id,
        "meeting_id": mid,
        "date": date.today().isoformat(),
        "mode": "lecture",
        "title": title,
        "source_type": "document",
        "preserve_existing": meeting_id is not None,
        "segments": [],
    }
    graph_store.load_intermediate(intermediate)
    chunks = chunk_document(text, f"doc-{doc_digest}", max_chars=max_chars)
    graph_store.load_chunks(project_id, mid, chunks)
    if vector_store is not None:
        vector_store.add_chunks(project_id, mid, chunks)
    topic_ids: set[str] = set()
    relation_count = 0
    for chunk in chunks:
        extraction = extract_chunk_topics(project_id, chunk)
        graph_store.load_extraction(project_id, mid, extraction)
        ids = [topic["topic_id"] for topic in extraction["topics"]]
        topic_ids.update(ids)
        for left, right in combinations(ids, 2):
            graph_store.relate_topics(project_id, left, right)
            relation_count += 1
    return {"project_id": project_id, "meeting_id": mid, "chunks": chunks,
            "topic_ids": sorted(topic_ids), "relations": relation_count, "loaded": True}


# ── 3) 중간 매개 함수: 입력 파일 → graphrag 적재 ────────


def ingest_files(
    paths: list[Path | str],
    project_id: str | None = None,
    meeting_id: str | None = None,
    graph_store=None,
    vector_store=None,
    max_chars: int = 800,
) -> dict:
    """입력 파일들을 받아 청크로 정리하고 Graph DB에 text 형태로 적재하는 중간 매개 함수.

    - 중간포맷 JSON 전사문 → Project·Meeting 노드(load_intermediate) + transcript 청크
    - 그 외 회의자료(txt/md/pdf/docx/pptx...) → document 청크 (파일명 stem이 doc 식별자)
    - project_id/meeting_id 미지정 시 전사문 JSON에서 가져온다 (자료만 있으면 필수).
    - graph_store=None이면 적재 없이 청크만 반환 (dry-run).

    반환: {project_id, meeting_id, chunks, skipped, loaded}
    """
    intermediates: list[dict] = []
    documents: list[tuple[str, str]] = []  # (doc_id, text)
    skipped: list[str] = []

    for raw in paths:
        path = Path(raw)
        if path.suffix.lower() == ".json":
            im = _load_intermediate_json(path)
            if im is not None:
                intermediates.append(im)
                continue
        text = extract_text(path)
        if text:
            documents.append((path.stem, text))
        else:
            skipped.append(path.name)

    if intermediates:
        project_id = project_id or intermediates[0]["project_id"]
        meeting_id = meeting_id or intermediates[0]["meeting_id"]
    if not project_id or not meeting_id:
        raise ValueError("project_id/meeting_id가 필요합니다 (전사문 JSON이 없으면 직접 지정).")

    # (meeting_id, 청크 목록) — 전사문은 각자 자기 meeting에, 자료는 지정 meeting에 걸린다
    batches: list[tuple[str, list[dict]]] = [
        (im["meeting_id"], chunk_transcript(im, max_chars=max_chars)) for im in intermediates
    ]
    doc_chunks: list[dict] = []
    for doc_id, text in documents:
        doc_chunks.extend(chunk_document(text, f"{meeting_id}-{doc_id}", max_chars=max_chars))
    if doc_chunks:
        batches.append((meeting_id, doc_chunks))

    loaded = False
    if graph_store is not None:
        for im in intermediates:
            graph_store.load_intermediate(im)
        if doc_chunks and meeting_id not in {im["meeting_id"] for im in intermediates}:
            # 자료만 들어와도 Meeting 노드는 있어야 HAS_CHUNK가 걸린다
            graph_store.load_intermediate({
                "project_id": project_id, "meeting_id": meeting_id,
                "date": date.today().isoformat(),
            })
        for mid, batch in batches:
            graph_store.load_chunks(project_id, mid, batch)
        loaded = True
    if vector_store is not None:
        for mid, batch in batches:
            vector_store.add_chunks(project_id, mid, batch)

    chunks = [c for _, batch in batches for c in batch]

    return {"project_id": project_id, "meeting_id": meeting_id,
            "chunks": chunks, "skipped": skipped, "loaded": loaded}


# ── CLI ─────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> None:
    """CLI: python -m backend.integration.pipeline 파일... [--project-id P --meeting-id M]

    NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD가 설정돼 있으면 적재, 없으면 dry-run으로 청크 요약만 출력.
    --vector를 주면 VectorStore(SUPABASE_DB_URL 필요)에도 적재.
    """
    import argparse
    import os

    parser = argparse.ArgumentParser(description="입력 파일 → 청크 → Graph DB 적재")
    parser.add_argument("files", nargs="+")
    parser.add_argument("--project-id")
    parser.add_argument("--meeting-id")
    parser.add_argument("--max-chars", type=int, default=800)
    parser.add_argument("--vector", action="store_true", help="VectorStore에도 적재")
    args = parser.parse_args(argv)

    graph_store = vector_store = None
    if os.getenv("NEO4J_URI"):
        from neo4j import GraphDatabase
        from backend.graphrag import GraphStore
        driver = GraphDatabase.driver(
            os.environ["NEO4J_URI"],
            auth=(os.environ.get("NEO4J_USER", "neo4j"), os.environ.get("NEO4J_PASSWORD", "")))
        graph_store = GraphStore(driver)
    if args.vector:
        from backend.graphrag import VectorStore
        vector_store = VectorStore()

    result = ingest_files(args.files, project_id=args.project_id, meeting_id=args.meeting_id,
                          graph_store=graph_store, vector_store=vector_store, max_chars=args.max_chars)

    print(f"project={result['project_id']} meeting={result['meeting_id']} "
          f"chunks={len(result['chunks'])} loaded={result['loaded']}")
    for c in result["chunks"]:
        preview = c["text"][:60].replace("\n", " ")
        print(f"  [{c['source_type']}] {c['chunk_id']}: {preview}")
    if result["skipped"]:
        print(f"skipped (텍스트 추출 실패/미지원): {', '.join(result['skipped'])}")


if __name__ == "__main__":
    main()
