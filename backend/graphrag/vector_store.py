from __future__ import annotations

"""VectorStore — 청크 임베딩 저장/검색 (Supabase Postgres + pgvector).

schemas/graph_vector_db.md: "청크 임베딩 + 메타데이터. 메타데이터 필터: project_id, meeting_id, source_type."
임베딩은 주입식(embed_fn). chunk_id로 Graph DB의 Chunk.vector_ref와 교차 참조.

**2026-07-15부터 Chroma에서 pgvector로 전환** (팀 결정 — 공통 벡터 스토어로 Supabase 채택).
연결은 SUPABASE_DB_URL 환경변수(Postgres 연결문자열)로 주입한다. **Session Pooler 문자열을
쓸 것** — Direct connection 호스트(`db.<ref>.supabase.co`)는 IPv6 전용이라 IPv6 미지원
네트워크에서 `could not translate host name` 에러로 연결이 실패한다. 대시보드 Connect →
Session pooler에서 복사.

**기본 embed_fn은 OpenAI `text-embedding-3-small`(임시, 사용자 지시 — 팀 확정 사항 아님, 추후
바뀔 수 있음)** — `backend/stt/refine_transcript.py`가 이미 같은 모델(1536차원)을 쓰고 있어서
그쪽과 호환. OPENAI_API_KEY 필요. 오프라인/결정론적 테스트가 필요하면 `embed_fn=hashing_embed`로
주입해서 대체 가능(여전히 export됨) — 단, 같은 테이블 안에서 embed_fn을 섞어 쓰면 벡터 차원이
달라 조회가 깨지니 주의.
"""

import hashlib
import os

import psycopg2
from psycopg2.extras import execute_values

_openai_client = None


def hashing_embed(text: str, dim: int = 256) -> list[float]:
    """의존성 없는 결정론적 임베더 (문자 n-gram 해싱). 오프라인 테스트용 — embed_fn으로 주입해서 사용."""
    v = [0.0] * dim
    t = " ".join((text or "").split())
    for n in (2, 3):
        for i in range(len(t) - n + 1):
            h = int.from_bytes(hashlib.md5(t[i:i + n].encode()).digest()[:4], "big")
            v[h % dim] += 1.0
    norm = sum(x * x for x in v) ** 0.5
    return [x / norm for x in v] if norm else v


def openai_embed(text: str, model: str = "text-embedding-3-small") -> list[float]:
    """VectorStore의 기본 embed_fn (임시 — 모델 선택은 팀 확정 전, 추후 변경될 수 있음)."""
    global _openai_client
    if _openai_client is None:
        from openai import OpenAI
        from backend.observability import wrap_openai_client

        _openai_client = wrap_openai_client(OpenAI())
    return _openai_client.embeddings.create(model=model, input=text or "").data[0].embedding


class VectorStore:
    def __init__(self, embed_fn=None, dsn: str | None = None, table: str = "chunks"):
        self.embed_fn = embed_fn or openai_embed
        self.table = table
        self.conn = psycopg2.connect(dsn or os.environ["SUPABASE_DB_URL"])
        self._init_schema()

    def _init_schema(self):
        with self.conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {self.table} (
                    chunk_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    meeting_id TEXT,
                    source_type TEXT NOT NULL DEFAULT 'unknown',
                    chunk_text TEXT NOT NULL,
                    embedding VECTOR NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY (project_id, chunk_id)
                );
            """)
            cur.execute(f"CREATE INDEX IF NOT EXISTS {self.table}_project_id_idx ON {self.table} (project_id);")
        self.conn.commit()

    def add_chunks(self, project_id: str, meeting_id: str, chunks: list[dict]):
        """chunk = {chunk_id, text, source_type}. 임베딩 후 메타데이터와 함께 upsert."""
        if not chunks:
            return
        rows = [
            (c["chunk_id"], project_id, meeting_id, c.get("source_type") or "unknown",
             c.get("text", ""), self.embed_fn(c.get("text", "")))
            for c in chunks
        ]
        with self.conn.cursor() as cur:
            execute_values(
                cur,
                f"""INSERT INTO {self.table} (chunk_id, project_id, meeting_id, source_type, chunk_text, embedding)
                    VALUES %s
                    ON CONFLICT (project_id, chunk_id) DO UPDATE SET
                        meeting_id = EXCLUDED.meeting_id,
                        source_type = EXCLUDED.source_type, chunk_text = EXCLUDED.chunk_text,
                        embedding = EXCLUDED.embedding""",
                rows,
            )
        self.conn.commit()

    def query(self, project_id: str, text: str, k: int = 8, source_type: str | None = None,
              meeting_id: str | None = None):
        sql = (f"SELECT chunk_id, chunk_text, meeting_id, source_type, embedding <=> %s::vector AS distance "
               f"FROM {self.table} WHERE project_id = %s")
        params = [self.embed_fn(text), project_id]
        if source_type:
            sql += " AND source_type = %s"
            params.append(source_type)
        if meeting_id:
            sql += " AND meeting_id = %s"
            params.append(meeting_id)
        sql += " ORDER BY distance LIMIT %s"
        params.append(k)

        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return [
            {"chunk_id": chunk_id, "text": chunk_text, "score": round(1.0 - distance, 4),
             "meeting_id": meeting_id, "source_type": source_type}
            for chunk_id, chunk_text, meeting_id, source_type, distance in rows
        ]

    def reset(self, project_id: str):
        with self.conn.cursor() as cur:
            cur.execute(f"DELETE FROM {self.table} WHERE project_id = %s", (project_id,))
        self.conn.commit()

    def delete_meeting(self, project_id: str, meeting_id: str) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                f"DELETE FROM {self.table} WHERE project_id = %s AND meeting_id = %s",
                (project_id, meeting_id),
            )
            deleted = cur.rowcount
        self.conn.commit()
        return deleted

    def delete_chunks_by_prefix(self, project_id: str, chunk_prefix: str) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                f"DELETE FROM {self.table} WHERE project_id = %s AND chunk_id LIKE %s",
                (project_id, f"{chunk_prefix}%"),
            )
            deleted = cur.rowcount
        self.conn.commit()
        return deleted
