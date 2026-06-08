---
title: "Session, memory, and context engine - Token Management Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Token Management Maturity Note

## Summary

OpenClaw has a broad compaction and pruning implementation: semantic summaries,
pre-prompt token estimation, overflow recovery, tool-result truncation, context
pruning, provider hooks, and manual `sessions.compact`. Coverage is relatively
strong for the high-risk algorithmic paths, but active reports show that
overflow, reserve-token math, user steering, and engine-owned compaction remain
operator-visible rough edges.

## Category Scope

This category covers manual and automatic compaction, preemptive overflow
checks, context-window estimation, session pruning, tool-result trimming,
compaction providers, retry/timeout behavior, and compacted transcript
checkpoints.

## Features

- Compaction: Covers Compaction across manual and automatic compaction, preemptive overflow checks, context-window estimation, session pruning, tool-result trimming, compaction providers, retry/timeout behavior, and compacted transcript checkpoints.
- Pruning: Covers Pruning across manual and automatic compaction, preemptive overflow checks, context-window estimation, session pruning, tool-result trimming, compaction providers, retry/timeout behavior, and compacted transcript checkpoints.
- Token Pressure: Covers Token Pressure across manual and automatic compaction, preemptive overflow checks, context-window estimation, session pruning, tool-result trimming, compaction providers, retry/timeout behavior, and compacted transcript checkpoints.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: compaction preparation, cut-point selection, branch summaries, preemptive overflow decisions, runtime retry, manual Gateway compaction, and context pruning all have focused test coverage.
- Negative signals: full long-running user-session scenarios across provider fallback, context-engine-owned compaction, and channel delivery are not equally represented.
- Integration gaps: add a release smoke that drives a real long session through precheck, semantic compaction, retry, checkpoint restore, and WebChat/history display.

## Quality Score

- Score: `Alpha (60%)`
- Gitcrawl reports: open issues cover silent preemptive overflow death, user-steered compaction, reserve token dead zones, and context-aware fallback behavior.
- Discrawl reports: Discord archive results include review comments about engine-owned compaction being bypassed, masked overflow errors, and reserve-token clamping fixes.
- Good qualities: the code has explicit token-pressure estimates, fallback routes, timeout guards, and persistent summaries.
- Bad qualities: overflow recovery remains complex and has produced user-visible masking, dead-zone, and silent-failure reports.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Compaction, Pruning, Token Pressure.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Context-overflow root causes can still be hard for operators to identify.
- Engine-owned compaction and built-in overflow recovery need very clear behavior boundaries.

## Evidence

### Docs

- `docs/concepts/compaction.md:11` explains summary replacement and transcript persistence.
- `docs/concepts/context.md:156` says compaction persists summaries while pruning only affects prompt assembly.
- `docs/reference/session-management-compaction.md:242` documents persisted compaction entries; `docs/reference/session-management-compaction.md:272` documents auto-compaction triggers and overflow recovery.

### Source

- `packages/agent-core/src/harness/compaction/compaction.ts:226` decides whether to compact; `packages/agent-core/src/harness/compaction/compaction.ts:616` prepares compaction; `packages/agent-core/src/harness/compaction/compaction.ts:712` runs compaction.
- `src/agents/embedded-agent-runner/run/preemptive-compaction.ts:242` decides pre-prompt compaction routes.
- `src/agents/embedded-agent-runner/run/compaction-retry-aggregate-timeout.ts:1` bounds retry waiting.
- `src/agents/agent-hooks/context-pruning/pruner.ts:287` prunes context messages.

### Integration tests

- `src/gateway/server.sessions.compaction.test.ts:277` runs manual `sessions.compact` through Gateway RPC.
- `src/agents/embedded-agent-runner/run.overflow-compaction.test.ts:1739` verifies overflow-triggered compaction retry routing.
- `src/infra/heartbeat-runner.transcript-prune.test.ts:88` covers heartbeat transcript pruning behavior.

### Unit tests

- `src/agents/embedded-agent-runner/run/preemptive-compaction.test.ts:102` requests preemptive compaction when reserve budget is exceeded.
- `src/agents/embedded-agent-runner/run/preemptive-compaction.test.ts:357` routes direct tool-result truncation when tool tails can absorb overflow.
- `src/plugins/compaction-provider.test.ts` covers provider registry behavior.

### Gitcrawl queries

Query:

`gitcrawl search issues "compaction context overflow preemptive compaction" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned open `#84536` silent preemptive overflow death, `#65502` context-aware fallback, `#84571` user-steered compaction, and `#66830` reserve-token dead zone.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "compaction context overflow preemptive compaction"`

Results:

- Returned archive discussion of implemented pre-send estimation, masked overflow errors, engine-owned compaction review risk, reserve-token clamping, and context-engine assembly during compaction.
