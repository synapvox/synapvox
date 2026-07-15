"""VectorStore — 청크 임베딩 저장/검색 (Supabase Postgres + pgvector).

`vector_store.py`(Chroma)와 동일한 공개 인터페이스(add_chunks/query/reset, embed_fn 주입식)의
drop-in 대체 구현. `schemas/graph_vector_db.md`가 "pgvector(또는 Chroma)"로 both 취급하던 것을
실제 pgvector 경로로 검증한 결과물 — 로컬(`synapvox_Local`)에서 Supabase Session Pooler로 연결
확인 + 임베딩 저장/코사인 유사도 검색 round-trip 검증 완료.

연결 정보는 SUPABASE_DB_URL 환경변수로 주입 (Session Pooler 문자열 권장 — Direct connection
호스트는 IPv6 전용이라 IPv6 미지원 네트워크에서 연결 실패함).

`__init__.py`의 기본 export는 아직 Chroma판(`vector_store.VectorStore`)이다 — 이 파일을 기본으로
바꿀지는 PR 리뷰에서 결정.
"""

import os

import psycopg2
from psycopg2.extras import execute_values

from .vector_store import hashing_embed

__all__ = ["VectorStore", "hashing_embed"]


class VectorStore:
    def __init__(self, embed_fn=None, dsn: str | None = None, table: str = "chunks"):
        self.embed_fn = embed_fn or hashing_embed
        self.table = table
        self.conn = psycopg2.connect(dsn or os.environ["SUPABASE_DB_URL"])
        self._init_schema()

    def _init_schema(self):
        with self.conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {self.table} (
                    chunk_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    meeting_id TEXT,
                    source_type TEXT NOT NULL DEFAULT 'unknown',
                    chunk_text TEXT NOT NULL,
                    embedding VECTOR NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                );
            """)
            cur.execute(f"CREATE INDEX IF NOT EXISTS {self.table}_project_id_idx ON {self.table} (project_id);")
        self.conn.commit()

    def add_chunks(self, project_id: str, meeting_id: str, chunks: list):
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
                    ON CONFLICT (chunk_id) DO UPDATE SET
                        project_id = EXCLUDED.project_id, meeting_id = EXCLUDED.meeting_id,
                        source_type = EXCLUDED.source_type, chunk_text = EXCLUDED.chunk_text,
                        embedding = EXCLUDED.embedding""",
                rows,
            )
        self.conn.commit()

    def query(self, project_id: str, text: str, k: int = 8, source_type: str | None = None):
        sql = (f"SELECT chunk_id, chunk_text, meeting_id, source_type, embedding <=> %s::vector AS distance "
               f"FROM {self.table} WHERE project_id = %s")
        params = [self.embed_fn(text), project_id]
        if source_type:
            sql += " AND source_type = %s"
            params.append(source_type)
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
