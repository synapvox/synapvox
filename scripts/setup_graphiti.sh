#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAPHITI_DIR="$ROOT_DIR/services/graphiti"
VENV_DIR="$GRAPHITI_DIR/server/.venv"

if [[ ! -f "$GRAPHITI_DIR/pyproject.toml" ]]; then
  echo "Graphiti submodule is missing. Run: git submodule update --init --recursive" >&2
  exit 1
fi

uv venv "$VENV_DIR" --python 3.12
uv pip install --python "$VENV_DIR/bin/python" \
  --editable "$GRAPHITI_DIR" \
  --editable "$GRAPHITI_DIR/server"

echo "Graphiti installed in $VENV_DIR"
