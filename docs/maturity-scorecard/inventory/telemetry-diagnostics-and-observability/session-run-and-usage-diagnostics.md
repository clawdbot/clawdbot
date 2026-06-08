---
title: "Observability - Session Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Session Diagnostics Maturity Note

## Summary

Session, run, and usage diagnostics make long-running or stuck agent work observable through session state events, queue depth, active work tracking, recovery events, token/cost usage, model-call timing, and usage logs. The source model is strong, but the operator-facing "what happened to my turn" story is split across logs, stability, OTEL/Prometheus, session commands, and chat diagnostics.

## Category Scope

Included in this category:

- session.state: session.state, session.stuck, session.long_running, session.stalled, session.recovery.\*, and session.turn.created diagnostic events
- Diagnostic session activity snapshots: Diagnostic session activity snapshots for embedded runs, model calls, and tool calls
- Model usage: Model usage, token/cost, model-call byte/timing, run attempts, and usage logs
- Export of session signals to stability: Export of session signals to stability, OpenTelemetry, and Prometheus

## Features

- session.state: session.state, session.stuck, session.long_running, session.stalled, session.recovery.\*, and session.turn.created diagnostic events
- Diagnostic session activity snapshots: Diagnostic session activity snapshots for embedded runs, model calls, and tool calls
- Model usage: Model usage, token/cost, model-call byte/timing, run attempts, and usage logs
- Export of session signals to stability: Export of session signals to stability, OpenTelemetry, and Prometheus

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Session state, stuck-session recovery, run activity, exporter mappings, and model-call telemetry have deep unit and integration-style tests.
- Negative signals: A complete real-user stuck-turn-to-operator-diagnosis scenario is less visible than isolated event and exporter tests.
- Integration gaps: Release proof should include a full queued session, stalled embedded run, recovery, and operator diagnosis path.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: The exact query returned no direct hits, so archive silence is neutral after freshness checks.
- Discrawl reports: The exact query returned no direct hits; broader OTEL archive results still cite session and recovery metrics as recently added signals.
- Good qualities: The implementation distinguishes long-running, stalled, and stuck work; tracks active work kinds; emits recovery requested/completed events; and avoids raw session identifiers in exporters.
- Bad qualities: The operator experience is fragmented because session diagnostics appear through several surfaces instead of one single diagnosis timeline.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for session.state, Diagnostic session activity snapshots, Model usage, Export of session signals to stability.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- There is no single public runbook that walks from "my turn is stuck" through session state, active work, stability, logs, and recovery events.
- Session diagnostic thresholds are documented mainly through adjacent diagnostics/export docs rather than a dedicated operator page.

## Evidence

### Docs

- `docs/gateway/opentelemetry.md` documents session, queue, stuck-session, recovery, run, and usage metrics.
- `docs/gateway/prometheus.md` documents Prometheus session state, queue depth, stuck, recovery, liveness, and turn-created metrics.
- `docs/gateway/diagnostics.md` documents liveness, active/waiting/queued session counts, phase spans, and terminal-progress stale markers.
- `docs/gateway/protocol.md` documents `sessions.usage.logs`.

### Source

- `src/logging/diagnostic.ts`, `src/logging/diagnostic-session-state.ts`, `src/logging/diagnostic-run-activity.ts`, and `src/logging/diagnostic-session-recovery-coordinator.ts` implement session state, active work tracking, stuck classification, and recovery events.
- `src/logging/diagnostic-stability.ts` projects session events into stability snapshots.
- `extensions/diagnostics-otel/src/service.ts` and `extensions/diagnostics-prometheus/src/service.ts` export session, recovery, and usage telemetry.
- `src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.ts` records model-call bytes, timing, usage, and trace context.

### Integration tests

- `src/logging/diagnostic-stuck-session-recovery.integration.test.ts` exercises stuck-session recovery flows.
- `src/agents/agent-tools.before-tool-call.e2e.test.ts` and `src/agents/agent-tools.before-tool-call.integration.e2e.test.ts` exercise diagnostic events during real tool-call paths.
- `scripts/qa-otel-smoke.ts` validates exported session/queue/usage signals in OTLP payloads.

### Unit tests

- `src/logging/diagnostic.test.ts` covers session state, queue depth, progress, stuck classification, thresholds, and recovery event behavior.
- `src/logging/diagnostic-run-activity.ts` is covered through diagnostic and agent runner tests.
- `extensions/diagnostics-otel/src/service.test.ts` and `extensions/diagnostics-prometheus/src/service.test.ts` cover session stuck, turn-created, and recovery metric/export behavior.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "session usage logs diagnostic run activity embedded agent telemetry" --limit 5`

Results:

- 0 hits returned for the exact feature query.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "session usage logs diagnostic run activity embedded agent telemetry"`

Results:

- 0 hits returned for the exact feature query.
