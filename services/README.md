# Local services

## Graphiti

Graphiti is pinned as a Git submodule at `services/graphiti`.

```bash
git submodule update --init --recursive
./scripts/setup_graphiti.sh
./scripts/run_graphiti.sh
```

The local Graphiti API listens on `http://127.0.0.1:8020` by default.
Swagger documentation is available at `http://127.0.0.1:8020/docs`.

The SynapVox integration backend uses this local endpoint by default. Graphiti
owns extraction, temporal knowledge ingestion, and fact search; the integration
backend adapts its Neo4j data to the existing frontend graph/detail contracts.

The service reads `OPENAI_API_KEY`, `NEO4J_URI`, `NEO4J_USER` (or
`NEO4J_USERNAME`), and `NEO4J_PASSWORD` from the repository root `.env`.
`GRAPHITI_MODEL` can override the default extraction model (`gpt-5-mini`).
