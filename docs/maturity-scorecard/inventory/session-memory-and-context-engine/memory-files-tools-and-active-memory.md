---
title: "Session, memory, and context engine - Memory Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Memory Maturity Note

## Summary

OpenClaw's memory surface combines user-facing memory behavior with the backend
storage and retrieval layer that makes it work. It includes canonical
`MEMORY.md`, dated `memory/*.md`, memory search tools, Active Memory pre-reply
recall, session-memory hooks, memory prompt sections, plugin memory
capabilities, SQLite-backed stores, optional sqlite-vec acceleration, remote
and local embedding providers, QMD collection config, and session transcript
indexing.

The combined category is scored at the more conservative backend level. Docs are
strong, but active reports still show stale indexes, session-memory poisoning,
dreaming pollution, active-memory timeout behavior, provider/model mismatch,
QMD/SQLite contention, and configuration complexity.

## Category Scope

This category covers root memory files, active memory, memory search/get/store
tool exposure, memory prompt sections, memory flush plans, session-memory hook
behavior, memory plugin capability registration visible to agents, memory
backend config, SQLite schema, vector acceleration, embedding provider
selection, remote embedding fetch, QMD process/query parsing, session transcript
indexing for search, extra paths, and backend security boundaries.

## Features

- Memory Backend Storage: Covers Memory Backend Storage across memory backend config, SQLite schema, vector acceleration, embedding provider selection, remote embedding fetch, QMD process/query parsing, session transcript indexing for search, extra paths, and backend security boundaries.
- Embedding Search: Covers Embedding Search across memory backend config, SQLite schema, vector acceleration, embedding provider selection, remote embedding fetch, QMD process/query parsing, session transcript indexing for search, extra paths, and backend security boundaries.
- Memory Files: Covers Memory Files across root memory files, active memory, memory search/get/store tool exposure, memory prompt sections, memory flush plans, session-memory hook behavior, and memory plugin capability registration visible to agents.
- Memory search and store tools: Covers memory search/get/store tool exposure, memory prompt sections, memory flush plans, session-memory hook behavior, and memory plugin capability registration visible to agents.
- Active Memory: Covers Active Memory across root memory files, active memory, memory search/get/store tool exposure, memory prompt sections, memory flush plans, session-memory hook behavior, and memory plugin capability registration visible to agents.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals: docs explain memory concepts, Active Memory, backend config, hybrid search, sqlite-vec acceleration, QMD backend config, and experimental session memory search. Source exposes canonical memory file resolution, memory runtime loading, prompt building, flush plans, session-memory hook behavior, backend config resolution, SQLite schema management, local/remote embedding providers, QMD process probing, and session-file indexing.
- Negative signals: active-memory end-to-end recall across selected memory plugins and channel-driven sessions is less proven than file/runtime unit behavior, while live provider reliability, QMD process availability, and multi-backend indexing flows are hard to prove with local unit tests.
- Integration gaps: add a scenario that stores a memory, indexes it, recalls it with Active Memory, performs pre-compaction flush, and confirms the result across direct and channel sessions; add a backend matrix smoke that runs builtin keyword fallback, sqlite-vec vector search, QMD lexical search, QMD vector readiness, and one remote embedding provider with failure injection.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: many open issues remain for stale memory indexes, live embedding reliability, QMD SQLite lock contention, docs/runtime mismatch, dreaming pollution, active-memory timeout classification, session-memory indexing, and memory tool capability coupling.
- Discrawl reports: archive discussions recommend file-based canonical memory plus QMD retrieval, explain Active Memory as a pre-reply layer, point out LanceDB capability coupling, and show troubleshooting around provider/model mismatch, empty indexes, missing memory directories, and QMD versus builtin search tradeoffs.
- Good qualities: the file-first mental model is understandable, memory plugin state has a consolidated capability API, backend config is explicit, defaults are conservative for interactive CPU-only use, and remote HTTP has an SSRF policy boundary.
- Bad qualities: memory runtime, indexing, Active Memory, dreaming, session memory, embedding/provider configuration, and backend performance/reliability interact in ways that can pollute, stall, or vary substantially by environment.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Memory Backend Storage, Embedding Search, Memory Files, Memory search and store tools, Active Memory.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Active Memory is still a thin but policy-sensitive layer, especially outside direct persistent chats.
- Tool names and plugin capabilities are still settling for non-core memory plugins.
- Operators need clearer diagnostics for empty indexes, dirty indexes, provider mismatch, and QMD lock contention.
- Session transcript search is still marked experimental in docs and config.

## Evidence

### Docs

- `docs/concepts/memory.md`, `docs/concepts/active-memory.md`, `docs/concepts/memory-search.md`, and `docs/cli/memory.md` document the user-visible memory model.
- `docs/reference/memory-config.md:35` says Active Memory uses plugin-owned config; `docs/reference/memory-config.md:410` documents experimental session memory search.
- `docs/reference/memory-config.md:47` documents provider selection; `docs/reference/memory-config.md:286` documents hybrid search; `docs/reference/memory-config.md:427` documents sqlite-vec acceleration; `docs/reference/memory-config.md:447` documents QMD backend config.
- `docs/concepts/memory-qmd.md` documents QMD usage and tradeoffs.
- `docs/channels/discord.md:285` explains how memory behaves in Discord guild channels.

### Source

- `src/memory/root-memory-files.ts:4` defines `MEMORY.md`; `src/memory/root-memory-files.ts:33` resolves the canonical root memory file.
- `src/plugins/memory-state.ts:230` builds memory prompt sections; `src/plugins/memory-state.ts:271` resolves memory flush plans.
- `src/plugins/memory-runtime.ts:56` obtains the active memory search manager.
- `src/hooks/bundled/session-memory/handler.ts:130` saves session context to memory on `/new` or `/reset`.
- `packages/memory-host-sdk/src/host/backend-config.ts:385` resolves memory backend config; `packages/memory-host-sdk/src/host/backend-config.ts:422` builds QMD paths and default collections.
- `packages/memory-host-sdk/src/host/memory-schema.ts:4` ensures the SQLite schema.
- `packages/memory-host-sdk/src/host/embeddings.ts:48` creates local embedding providers; `packages/memory-host-sdk/src/host/embeddings-remote-fetch.ts:31` fetches remote embedding vectors.
- `packages/memory-host-sdk/src/host/qmd-process.ts:49` checks QMD binary availability; `packages/memory-host-sdk/src/host/session-files.ts:300` lists session files for indexing.

### Integration tests

- `src/hooks/bundled/session-memory/handler.test.ts:255` verifies memory file creation from session content.
- `src/plugin-sdk/memory-host-search.test.ts` covers SDK-backed active memory search manager access.
- `src/agents/memory-search.test.ts:237` covers session-memory sync configuration used by runtime indexing.
- `packages/memory-host-sdk/src/host/remote-http.test.ts` covers remote HTTP behavior.
- `packages/memory-host-sdk/src/host/qmd-process.test.ts:139` covers QMD availability probing and command failure handling.
- `packages/memory-host-sdk/src/host/session-files.test.ts:47` verifies session transcript listing behavior for memory indexing.

### Unit tests

- `src/plugins/memory-state.test.ts:80` checks empty defaults and `src/plugins/memory-state.test.ts:121` checks capability registration precedence.
- `src/plugins/memory-runtime.test.ts:193` loads only the configured memory slot plugin.
- `src/memory/root-memory-files.test.ts` covers root memory file behavior.
- `packages/memory-host-sdk/src/host/backend-config.test.ts` covers backend config resolution.
- `packages/memory-host-sdk/src/host/embedding-chunk-limits.test.ts:69` covers provider input limits.
- `packages/memory-host-sdk/src/host/sqlite-vec.test.ts` covers sqlite-vec loading behavior.

### Gitcrawl queries

Query:

`gitcrawl search issues "memory qmd embeddings sqlite-vec memorySearch" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned open `#71784 Bug: memory search live embedding fails ~20-40% with fetch failed / other side closed`.

Query:

`gitcrawl search issues "memory_search MEMORY.md active-memory" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned open reports including `#40088` stale file watcher, `#66339` QMD SQLite lock contention, `#77831` dreaming pollution, `#53550` session memory search gaps, `#74586` active-memory timeout classification, and `#49524` live-session stalls.
- Also returned QMD SQLite lock contention, docs/runtime mismatch, and file-watcher stale-index reports relevant to backend quality.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "memory qmd embeddings sqlite-vec memorySearch"`

Results:

- Returned Discord troubleshooting for embedding provider/model mismatch, empty index and missing memory directory, and discussion comparing memory-core SQLite hybrid search with QMD backend behavior.

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "memory_search MEMORY.md active-memory"`

Results:

- Returned discussions about Active Memory decoupling from hardcoded tool names, pre-reply memory implementation, automatic memory flush before compaction, and file-first memory recommendations.
