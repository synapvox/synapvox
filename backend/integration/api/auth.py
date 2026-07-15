"""Supabase Auth JWT verification for FastAPI endpoints.

Verifies the `Authorization: Bearer <token>` header against this Supabase project's
JWKS endpoint (SUPABASE_URL/auth/v1/.well-known/jwks.json) — no shared JWT secret needed,
this project signs with ES256 (asymmetric). Frontend gets the token from
`supabase.auth.getSession()` after `signUp`/`signInWithPassword` (see supabaseClient.ts).
"""

import os

import jwt
from fastapi import Header, HTTPException

_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        supabase_url = os.environ["SUPABASE_URL"]
        _jwks_client = jwt.PyJWKClient(f"{supabase_url}/auth/v1/.well-known/jwks.json")
    return _jwks_client


def _decode_token(token: str, jwks_client: jwt.PyJWKClient) -> dict:
    try:
        signing_key = jwks_client.get_signing_key_from_jwt(token)
        return jwt.decode(token, signing_key.key, algorithms=["ES256"], audience="authenticated")
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"invalid token: {exc}") from exc


def require_user(authorization: str = Header(default="")) -> dict:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    return _decode_token(token, _get_jwks_client())
