import pathlib
import sys
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[4]))  # repo root

from backend.integration.api.auth import _decode_token, require_user


class _FakeSigningKey:
    def __init__(self, key):
        self.key = key


class _FakeJWKSClient:
    """Stands in for jwt.PyJWKClient — returns a fixed public key instead of hitting Supabase's JWKS endpoint."""

    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return _FakeSigningKey(self._public_key)


def _make_token(private_key, claims: dict) -> str:
    return jwt.encode(claims, private_key, algorithm="ES256")


@pytest.fixture
def keypair():
    private_key = ec.generate_private_key(ec.SECP256R1())
    return private_key, private_key.public_key()


def test_decode_token_accepts_valid_signature(keypair):
    private_key, public_key = keypair
    token = _make_token(private_key, {"sub": "user-1", "aud": "authenticated", "exp": int(time.time()) + 60})

    claims = _decode_token(token, _FakeJWKSClient(public_key))

    assert claims["sub"] == "user-1"


def test_decode_token_rejects_expired_token(keypair):
    private_key, public_key = keypair
    token = _make_token(private_key, {"sub": "user-1", "aud": "authenticated", "exp": int(time.time()) - 60})

    with pytest.raises(HTTPException) as exc_info:
        _decode_token(token, _FakeJWKSClient(public_key))
    assert exc_info.value.status_code == 401


def test_decode_token_rejects_signature_from_a_different_key(keypair):
    _, public_key = keypair
    other_private_key = ec.generate_private_key(ec.SECP256R1())
    token = _make_token(other_private_key, {"sub": "user-1", "aud": "authenticated", "exp": int(time.time()) + 60})

    with pytest.raises(HTTPException) as exc_info:
        _decode_token(token, _FakeJWKSClient(public_key))
    assert exc_info.value.status_code == 401


def test_require_user_rejects_missing_authorization_header():
    with pytest.raises(HTTPException) as exc_info:
        require_user(authorization="")
    assert exc_info.value.status_code == 401


def test_require_user_rejects_non_bearer_authorization_header():
    with pytest.raises(HTTPException) as exc_info:
        require_user(authorization="Basic dXNlcjpwYXNz")
    assert exc_info.value.status_code == 401
