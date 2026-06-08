---
title: "Session, memory, and context engine - Diagnostics, Maintenance, and Recovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Diagnostics, Maintenance, and Recovery Maturity Note

## Summary

Diagnostics and recovery for sessions are substantial: session state tracking,
attention classification, stuck-session recovery, restart-aborted main-session
recovery, orphaned subagent recovery, delivery queue recovery, diagnostics
bundles, and maintenance warnings all exist. The risk is that recovery is still
best-effort and spread across multiple subsystems, so operators need clear
outcomes and safe defaults when a session is stuck or history is suspect.

## Category Scope

This category covers stuck-session diagnostics, restart recovery, orphaned
subagent resume, session maintenance warnings, delivery queues, diagnostic
bundles, stability snapshots, transcript repair surfaces, and memory/session
diagnostic visibility.

## Features

- Session diagnostic reports: Covers stuck-session diagnostics, diagnostic bundles, stability snapshots, and operator visibility into transcript and session health.
- Session maintenance warnings: Covers restart maintenance warnings, delivery queues, memory/session cleanup signals, and operator-visible maintenance state.
- Session and transcript recovery: Covers restart recovery, orphaned subagent resume, transcript repair, and safe restoration of session state after failures.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: source and tests cover session-state maps, stuck-session recovery, main-session restart recovery, delivery-queue recovery, diagnostics Gateway methods, support bundles, and maintenance warnings.
- Negative signals: live operator flows for diagnosing a stuck session and confirming recovery across channels are less complete than helper/runtime tests.
- Integration gaps: add a scenario that forces a stale active run, runs diagnostics, performs recovery, checks session lane state, and verifies no transcript/history loss.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: exact stuck-session diagnostic query returned no results, but related session cleanup and transcript archive issues remain active quality risks for maintenance.
- Discrawl reports: exact stuck-session diagnostic query returned no rows; session maintenance query returned archive discussions about reset archives and retention cleanup review concerns.
- Good qualities: recovery actions log explicit outcomes and often avoid destructive action unless configured; diagnostic bundles have privacy guidance.
- Bad qualities: recovery/maintenance surfaces are distributed, and a wrong cleanup/recovery path can look successful while hiding history.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Session diagnostic reports, Session maintenance warnings, Session and transcript recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Operators need one clearer decision tree for stuck session, missing history, transcript lock, and cleanup problems.
- Recovery proof should show before/after session lane, transcript, and delivery state.

## Evidence

### Docs

- `docs/gateway/diagnostics.md:10` describes diagnostics bundles; `docs/gateway/diagnostics.md:75` lists bundle contents; `docs/gateway/diagnostics.md:112` documents the stability recorder.
- `docs/reference/session-management-compaction.md:77` documents maintenance controls and cleanup; `docs/reference/session-management-compaction.md:97` documents transcript write-lock behavior.
- `docs/diagnostics/flags.md:128` describes diagnostics timeline records.

### Source

- `src/logging/diagnostic-session-state.ts:35` stores session diagnostic state; `src/logging/diagnostic-session-attention.ts:27` classifies session attention.
- `src/logging/diagnostic-stuck-session-recovery.runtime.ts:84` recovers stuck diagnostic sessions.
- `src/agents/subagent-orphan-recovery.ts:183` scans and resumes orphaned subagent sessions.
- `src/agents/main-session-restart-recovery.ts:539` recovers interrupted main sessions.
- `src/infra/session-delivery-queue-recovery.ts` and `src/infra/session-maintenance-warning.ts` back delivery/maintenance safety.

### Integration tests

- `src/logging/diagnostic-stuck-session-recovery.runtime.test.ts:161` reclaims stale active embedded runs.
- `src/agents/main-session-restart-recovery.test.ts:390` resumes marked sessions with a tool-result transcript tail.
- `src/infra/session-delivery-queue.recovery.test.ts` covers retry/backoff persistence for delivery recovery.

### Unit tests

- `src/infra/session-maintenance-warning.test.ts` covers active-session maintenance warnings.
- `src/gateway/server-methods/diagnostics.test.ts:27` returns filtered stability snapshots.
- `src/logging/diagnostic-memory.test.ts` covers memory diagnostics helpers.

### Gitcrawl queries

Query:

`gitcrawl search issues "stuck session session recovery transcript repair memory diagnostic" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned `[]`.

Query:

`gitcrawl search issues "sessions cleanup session maintenance transcript archive" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned open `#77941` for native sessions cleanup support and `#60745` for ephemeral sessions.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "stuck session session recovery transcript repair memory diagnostic"`

Results:

- Returned no matching rows.

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "sessions cleanup session maintenance transcript archive"`

Results:

- Returned session auto-reset archive explanations and review comments about compaction archive retention cleanup behavior.
