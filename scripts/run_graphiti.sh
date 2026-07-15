#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/services/graphiti/server"
PYTHON="$SERVER_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "Graphiti is not installed. Run: ./scripts/setup_graphiti.sh" >&2
  exit 1
fi

set -a
source "$ROOT_DIR/.env"
set +a

export NEO4J_USER="${NEO4J_USER:-${NEO4J_USERNAME:-}}"
export PORT="${GRAPHITI_PORT:-8020}"

cd "$ROOT_DIR"
exec "$PYTHON" -m uvicorn backend.integration.graphiti_host:app \
  --host "${GRAPHITI_HOST:-127.0.0.1}" \
  --port "$PORT"
