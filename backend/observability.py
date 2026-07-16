"""Shared LangSmith instrumentation for direct OpenAI SDK clients."""

from __future__ import annotations

import os
from typing import Any


def langsmith_enabled() -> bool:
    return (
        os.getenv("LANGSMITH_TRACING", "").strip().lower() == "true"
        and bool(os.getenv("LANGSMITH_API_KEY"))
    )


def wrap_openai_client(client: Any) -> Any:
    """Wrap sync or async OpenAI clients only when tracing is configured."""
    if not langsmith_enabled():
        return client
    from langsmith.wrappers import wrap_openai

    return wrap_openai(client)
