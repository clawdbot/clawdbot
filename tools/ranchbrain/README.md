# RanchBrain

RanchBrain is the local-first knowledge and memory module for OpenClaw.

## Phase 2 foundation

Current capabilities:

- Local Markdown knowledge folders
- PostgreSQL and pgvector health checks
- Long-term-memory record counts
- Ollama embedding-service checks
- Read-only status command through the OpenClaw Router

## Knowledge folders

- `knowledge/ranchbrain/inbox`
  New material waiting to be reviewed or indexed.

- `knowledge/ranchbrain/notes`
  Approved long-term Markdown notes.

- `knowledge/ranchbrain/archive`
  Retired or superseded notes.

## Planned capabilities

1. Add and retrieve Markdown notes.
2. Chunk and embed documents locally.
3. Search using PostgreSQL/pgvector.
4. Provide cited answers from stored knowledge.
5. Add MCP tools for RanchBrain access.
