---
title: "Observability - Stability Recorder and Runtime Pressure Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Stability Recorder and Runtime Pressure Maturity Note

## Summary

The stability recorder captures bounded, payload-free runtime events for memory pressure, large payloads, liveness warnings, session state, queue state, model calls, tool calls, Talk, delivery, and exporter health. The implementation is careful about data minimization and bounded retention, but runtime-pressure proof is still more source/test-driven than live-operator-driven.

## Category Scope

- Bounded in-process stability recorder and `diagnostics.stability` RPC.
- `openclaw gateway stability`, stability filtering, persisted stability bundles, and export-from-bundle.
- Memory pressure events, event-loop liveness warnings, oversized payload events, queue/session summaries, and fatal/shutdown/restart snapshots.
- Critical memory pressure snapshot option with V8/cgroup/session-file evidence.

## Features

- Bounded in-process stability recorder: Bounded in-process stability recorder and diagnostics.stability RPC
- openclaw gateway stability: openclaw gateway stability, stability filtering, persisted stability bundles, and export-from-bundle
- Memory pressure events: Memory pressure events, event-loop liveness warnings, oversized payload events, queue/session summaries, and fatal/shutdown/restart snapshots
- Critical memory pressure snapshot option: Critical memory pressure snapshot option with V8/cgroup/session-file evidence

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Stability projection, filtering, memory/payload summaries, and persisted bundle behavior have focused tests and are exercised by the kitchen-sink RPC walk.
- Negative signals: Fatal-exit, shutdown-timeout, critical memory-pressure, and real event-loop saturation scenarios are harder to prove repeatedly in local tests.
- Integration gaps: Release-level proof should include a real gateway producing and exporting a stability bundle under simulated pressure.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports: PR #84836 on delayed fetch timeouts is a relevant pressure-signal item, but there is not a broad cluster of stability recorder failures.
- Discrawl reports: The exact feature query returned no direct Discord hits, so archive silence is neutral after freshness checks.
- Good qualities: The recorder sanitizes events, uses safe reason codes, caps retention, summarizes memory and payload-large events, and redacts persisted bundle metadata.
- Bad qualities: Operators still need to know when to inspect `gateway stability` versus diagnostics export or logs; that first-stop guidance is scattered.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bounded in-process stability recorder, openclaw gateway stability, Memory pressure events, Critical memory pressure snapshot option.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Critical memory pressure bundle behavior is opt-in and should have clearer runbook guidance.
- `diagnostics.stability` is powerful but not yet framed as the primary first-stop operator timeline in the maturity scorecard row.

## Evidence

### Docs

- `docs/gateway/diagnostics.md` documents the bounded stability recorder, liveness warnings, `openclaw gateway stability`, persisted bundles, and export options.
- `docs/gateway/health.md` documents memory pressure, event-loop delay, oversized payload events, and fatal/restart persistence.
- `docs/gateway/protocol.md` documents `diagnostics.stability` as an operator-read RPC.

### Source

- `src/logging/diagnostic-stability.ts` implements the bounded recorder, payload-free event projection, filtering, and summaries.
- `src/logging/diagnostic-stability-bundle.ts` writes persisted bundles with redacted error, host, V8, cgroup, resource, and session-file evidence.
- `src/gateway/server-methods/diagnostics.ts` exposes `diagnostics.stability`.
- `src/gateway/server/event-loop-health.ts` and `src/logging/diagnostic-memory.ts` feed liveness and memory events.

### Integration tests

- `scripts/e2e/kitchen-sink-rpc-walk.mjs` calls `diagnostics.stability` and fails on rejected/truncated/chunked instability signals.
- `src/gateway/gateway-stability.test.ts` exercises stability snapshots through gateway-facing behavior.

### Unit tests

- `src/logging/diagnostic-stability.test.ts` covers payload-free projection, reason sanitization, memory and large payload summaries, filtering, and bounded retention.
- `src/logging/diagnostic-stability-bundle.test.ts` covers persisted bundle behavior and redaction.
- `src/gateway/server-methods/diagnostics.test.ts` covers `diagnostics.stability` RPC handling.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "diagnostics stability memory pressure payload event loop" --limit 5`

Results:

- 1 hit. PR #84836 `fix(gateway): surface delayed fetch timeouts` notes delayed timeout drift as an event-loop pressure signal for downstream diagnostics consumers.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "diagnostics stability memory pressure payload event loop"`

Results:

- 0 hits returned for the exact feature query.
