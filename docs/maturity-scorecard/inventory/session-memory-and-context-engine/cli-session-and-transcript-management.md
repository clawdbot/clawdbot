---
title: "Session, memory, and context engine - CLI Session and Transcript Management Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - CLI Session and Transcript Management Maturity Note

## Summary

The operator CLI exposes practical session and transcript inspection paths:
`openclaw sessions`, cleanup, trajectory export, task audit/maintenance, and
`openclaw transcripts` list/show/path. It is backed by Gateway RPCs where
possible and falls back to explicit offline paths. Coverage is solid for command
registration and Gateway session RPCs, but transcript CLI behavior is thinner
than session management and archive evidence shows cleanup/restore expectations
still outpace the operator UX.

## Category Scope

This category covers `openclaw sessions`, `openclaw transcripts`, cleanup,
show/list/path behavior, TUI session history actions, and Gateway-backed session
management commands.

## Features

- CLI Session: Covers CLI Session across `openclaw sessions`, `openclaw transcripts`, cleanup, show/list/path behavior, TUI session history actions, and Gateway-backed session management commands.
- Transcript Management: Covers Transcript Management across `openclaw sessions`, `openclaw transcripts`, cleanup, show/list/path behavior, TUI session history actions, and Gateway-backed session management commands.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: CLI registration covers sessions list/cleanup/export/audit/show/notify/cancel flows, Gateway session RPC tests exercise list, resolve, patch, cleanup, compact, delete, and reset, and TUI tests cover history refresh and session selection.
- Negative signals: transcript CLI commands are simpler and less broadly exercised; restore and archive workflows are not proven end to end from CLI docs to Gateway state.
- Integration gaps: add a CLI scenario that runs `sessions cleanup --dry-run`, `sessions cleanup --enforce`, `transcripts list`, `transcripts show`, and a Gateway `chat.history` read against the same fixture.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: session/transcript archive search found open reports for cleanup of orphan/unindexed transcripts and restore support.
- Discrawl reports: Discord archive discussions show operators asking about auto-reset archives and review concerns about compaction archive retention cleanup.
- Good qualities: CLI docs and command help are explicit, machine-readable JSON is available, and non-dry-run cleanup delegates to Gateway when reachable.
- Bad qualities: CLI repair advice can still be dangerous when it archives valid history as orphaned or lacks a restore route.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for CLI Session, Transcript Management.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Transcript inspection exists, but user-facing restore/branch/archive workflows remain scattered.
- Cleanup guidance needs stronger guardrails when `sessions.json` and JSONL transcripts disagree.

## Evidence

### Docs

- `docs/concepts/session.md:142` lists `openclaw status`, `openclaw sessions --json`, `/status`, and `/context list`.
- `docs/reference/session-management-compaction.md:114` documents `openclaw sessions cleanup --dry-run` and `--enforce`.
- `docs/cli/sessions.md` and `docs/cli/transcripts.md` are the CLI-specific entrypoints for operator use.

### Source

- `src/cli/program/register.status-health-sessions.ts:175` registers the `sessions` command; `src/cli/program/register.status-health-sessions.ts:210` registers cleanup.
- `src/cli/program/register.transcripts.ts:290` registers `transcripts`; `src/cli/program/register.transcripts.ts:221` lists stored transcript sessions; `src/cli/program/register.transcripts.ts:249` shows one transcript.
- `src/tui/tui-session-actions.ts:236` lists sessions; `src/tui/tui-session-actions.ts:299` loads history; `src/tui/tui-session-actions.ts:397` aborts active runs.

### Integration tests

- `src/gateway/server.sessions.store-rpc.test.ts:35` validates Gateway-backed session list/patch/cleanup/reset/compact/delete RPCs.
- `src/gateway/server.sessions.compaction.test.ts:277` validates manual `sessions.compact` over Gateway RPC.
- `src/tui/gateway-chat.test.ts:572` verifies TUI retries `chat.history` during Gateway startup.

### Unit tests

- `src/tui/tui-session-actions.test.ts:60` verifies queued session refreshes; `src/tui/tui-session-actions.test.ts:549` remembers selected sessions after history loads.
- `src/tui/tui-last-session.test.ts:26` persists last session state and avoids heartbeat-like sessions.
- `src/cli/program/register.transcripts.test.ts` covers transcript command registration and parsing behavior.

### Gitcrawl queries

Query:

`gitcrawl search issues "openclaw sessions transcripts chat.history" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned 13 open reports touching session transcript restore, cleanup, history visibility, and session persistence.

Query:

`gitcrawl search issues "sessions cleanup session maintenance transcript archive" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned open `#77941 Add native sessions cleanup support for orphan/unindexed transcript archive/prune` and `#60745 Feature: ephemeral sessions`.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "sessions cleanup session maintenance transcript archive"`

Results:

- Returned Discord discussion explaining idle reset archives, reset retention, and PR review comments about compaction archive cleanup in warn/enforce modes.
