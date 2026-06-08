---
title: "Session, memory, and context engine - Transcript Persistence Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Transcript Persistence Maturity Note

## Summary

Transcript persistence has strong architecture and implementation: Gateway owns
session state, `sessions.json` maps keys to active transcript files, and JSONL
transcripts are append-only, locked, redacted, indexed, archived, and budgeted.
The risk is operational durability under reset, cleanup, context overflow, and
backup/restore: archive evidence shows multiple open reports where valid history
can be hidden, orphaned, or grow without bounds.

## Category Scope

This category covers JSONL session files, transcript append and redaction,
session write locks, transcript rotation/archive behavior, disk budget cleanup,
provider transcript stores, and restart/repair durability.

## Features

- Transcript Persistence: Covers Transcript Persistence across JSONL session files, transcript append and redaction, session write locks, transcript rotation/archive behavior, disk budget cleanup, provider transcript stores, and restart/repair durability.
- Durability: Covers Durability across JSONL session files, transcript append and redaction, session write locks, transcript rotation/archive behavior, disk budget cleanup, provider transcript stores, and restart/repair durability.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: source covers transcript headers, append queues, file locks, redaction, idempotency, maintenance, and disk-budget cleanup; Gateway history tests exercise bounded transcript reads and HTTP/SSE history.
- Negative signals: backup/restore and full durability workflows are less directly proven than hot-path append/read behavior.
- Integration gaps: add a restart-and-restore scenario that spans append, reset, archive, cleanup dry-run, cleanup enforce, history read, and explicit recovery from a previous transcript.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: several open issues describe nonexistent transcript mapping, unbounded transcript growth, backup/restore support, missing JSONL headers, doctor archiving history as orphaned, and WebChat hiding archived sessions.
- Discrawl reports: Discord archive results discuss orphaned transcript cleanup, compaction checkpoint history preservation, transcript-only artifacts leaking into history, and confusion over native CLI history stores versus OpenClaw transcripts.
- Good qualities: the source has disciplined append queues, write locks, redaction, archive naming, and disk-budget cleanup primitives.
- Bad qualities: user-facing data durability still has active loss/hiding risks around reset, cleanup, orphan detection, and cross-store restoration.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Transcript Persistence, Durability.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Operators do not yet have a complete restore story for all reset/archive/orphan paths.
- History durability depends on several interacting files and cleanup policies, making unsafe repair recommendations costly.

## Evidence

### Docs

- `docs/reference/session-management-compaction.md:40` defines two persistence layers: `sessions.json` and transcript JSONL.
- `docs/reference/session-management-compaction.md:57` says hot history readers should use bounded tail reads or the transcript index.
- `docs/reference/session-management-compaction.md:77` documents store maintenance, reset archives, disk budgets, and cleanup commands.
- `docs/reference/transcript-hygiene.md:10` documents provider-specific repair and backup behavior before durable rewrites.

### Source

- `src/config/sessions/transcript.ts:105` resolves transcript files; `src/config/sessions/transcript.ts:199` appends assistant messages.
- `src/config/sessions/transcript-append.ts:203` serializes per-transcript append queues; `src/config/sessions/transcript-append.ts:284` acquires write locks; `src/config/sessions/transcript-append.ts:346` redacts before append.
- `src/config/sessions/store.ts:360` saves session stores; `src/config/sessions/store.ts:675` archives removed session transcripts.
- `src/config/sessions/disk-budget.ts:535` enforces sessions-directory disk budgets.

### Integration tests

- `src/gateway/sessions-history-http.test.ts:296` returns session history over direct REST; `src/gateway/sessions-history-http.test.ts:456` streams bounded history over SSE.
- `src/gateway/server.sessions.store-rpc.test.ts:421` verifies reset creates a new session id and archives the old transcript.
- `src/gateway/server.sessions.compaction.test.ts:24` covers checkpoint branch/restore behavior over compacted transcripts.

### Unit tests

- `src/config/sessions/transcript-append-redact.test.ts:45` verifies secrets are masked before disk writes; `src/config/sessions/transcript-append-redact.test.ts:432` verifies delivery mirror dedupe.
- `src/config/sessions/disk-budget.test.ts` and `src/config/sessions/store.pruning.test.ts` cover maintenance and cleanup helpers.
- `packages/agent-core/src/harness/session/jsonl-repo.ts:38` implements JSONL session repository behavior.

### Gitcrawl queries

Query:

`gitcrawl search issues "transcript jsonl session file disk budget" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned open `#75151 Context overflow reset can map sessionFile to nonexistent transcript` and `#85025 Defaults cause unbounded transcript growth + nightly session death`.

Query:

`gitcrawl search issues "openclaw sessions transcripts chat.history" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned 13 open reports, including `#86382` backup/JSONL preservation, `#84209` persisted `sessionKey` in headers, `#73471` doctor archiving historical transcripts as orphans, `#77819` WebChat hiding archived sessions, and `#45003` restore script request.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "transcript jsonl session file disk budget"`

Results:

- Returned no matching rows.

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "openclaw sessions transcripts chat.history"`

Results:

- Returned PR/review and support discussions about orphaned JSONL cleanup, preserving chat history across compaction checkpoints, hiding transcript-only artifacts, and native CLI history not appearing in WebChat.
