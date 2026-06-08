---
title: "Observability Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (80%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (80%)`
- LTS Features: `3/5`

## Summary

This report promotes the archived `telemetry-diagnostics-and-observability` maturity evidence from `/Users/kevinlin/tmp/maturity/telemetry-diagnostics-and-observability` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                         | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | --- | -------------- | -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Health and Repair](health-status-probes.md)                     | ✅  | `Stable (80%)` | `Beta (76%)`   | `Stable (80%)` | Background health-monitor loop, Per-account enable/disable settings, Startup grace, Restart logging, openclaw doctor, Structured health checks, Core doctor checks, Plugin SDK doctor/health contracts, openclaw status, openclaw health, Gateway RPC health, Cached health snapshots                                                                                                                           |
| [Logging](logging-log-tail-and-redaction.md)                     | ✅  | `Stable (82%)` | `Stable (84%)` | `Stable (82%)` | Rolling Gateway JSONL file logs, openclaw logs, Gateway RPC logs.tail, Redaction patterns and sinks, Trace correlation fields                                                                                                                                                                                                                                                                                   |
| [Diagnostic Collection](diagnostics-export-support-bundles.md)   | ❌  | `Beta (76%)`   | `Beta (74%)`   | `Beta (76%)`   | openclaw gateway diagnostics export, openclaw gateway stability --bundle, Chat /diagnostics, Support zip composition, Bounded in-process stability recorder, openclaw gateway stability, Memory pressure events, Critical memory pressure snapshot option                                                                                                                                                       |
| [Telemetry Export](diagnostic-events-hooks-and-trace-context.md) | ❌  | `Beta (78%)`   | `Beta (78%)`   | `Beta (78%)`   | Diagnostic event types, Async dispatch, W3C trace context creation, Plugin SDK diagnostic runtime exports, Model-call diagnostic events, diagnostics-otel plugin install, OTLP/HTTP traces, Trusted trace context, Model and runtime telemetry, diagnostics-prometheus plugin install, Gateway-authenticated GET /api/diagnostics/prometheus, Prometheus text exposition, Trusted diagnostic event subscription |
| [Session Diagnostics](session-run-and-usage-diagnostics.md)      | ✅  | `Stable (82%)` | `Beta (78%)`   | `Stable (82%)` | session.state, Diagnostic session activity snapshots, Model usage, Export of session signals to stability                                                                                                                                                                                                                                                                                                       |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Health and Repair

Search anchors: channel health monitor, restart cooldowns, stale transport activity, openclaw doctor --fix, structured health checks, repair results, openclaw health --json, gateway RPC health, cached health snapshots.

Category note: [Health and Repair](health-status-probes.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Beta (76%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- Background health-monitor loop: Background health-monitor loop for configured channel accounts
- Per-account enable/disable settings: Per-account enable/disable settings behavior, status, and operator-visible verification.
- Startup grace: Startup grace, connect grace, stale transport activity detection, busy/stuck handling, restart cooldowns, and max restarts per hour
- Restart logging: Restart logging and runtime snapshot evaluation
- openclaw doctor: openclaw doctor, openclaw doctor --fix, --repair, --yes, --non-interactive, --deep, and --lint
- Structured health checks: Structured health checks, findings, repair results, check selection, JSON lint output, severity filtering, and exit behavior
- Core doctor checks: Core doctor checks for gateway config, services, auth, state integrity, skills, plugins, sandbox, migrations, and provider route health
- Plugin SDK doctor/health contracts: Plugin SDK doctor/health contracts behavior, status, and operator-visible verification.
- openclaw status: openclaw status, openclaw status --all, and openclaw status --deep
- openclaw health: openclaw health, openclaw health --verbose, and openclaw health --json
- Gateway RPC health: Gateway RPC health and status
- Cached health snapshots: Cached health snapshots, live probe refresh, sensitive fields gated by operator admin scope, and event-loop health attachment

Primary docs:

- `docs/gateway/health.md`
- `docs/channels/telegram.md`
- `docs/cli/doctor.md`
- `docs/gateway/doctor.md`
- `docs/plugins/sdk-subpaths.md`
- `docs/cli/health.md`
- `docs/gateway/protocol.md`

### 2. Logging

Search anchors: openclaw logs --follow, logs.tail, redaction patterns.

Category note: [Logging](logging-log-tail-and-redaction.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Stable (84%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Rolling Gateway JSONL file logs: Rolling Gateway JSONL file logs and console output
- openclaw logs: openclaw logs, openclaw logs --follow, JSON/plain/color/timezone modes, and local fallback behavior
- Gateway RPC logs.tail: Gateway RPC logs.tail behavior, status, and operator-visible verification.
- Redaction patterns and sinks: console, file logs, OTLP log records, transcript text, Control UI tool-call events, support exports, and WS protocol logs
- Trace correlation fields: Trace correlation fields on log records and linked diagnostic events.

Primary docs:

- `docs/logging.md`
- `docs/gateway/logging.md`
- `docs/cli/logs.md`

### 3. Diagnostic Collection

Search anchors: gateway diagnostics export, support bundle, privacy manifest, gateway stability, memory pressure events, critical memory pressure snapshot.

Category note: [Diagnostic Collection](diagnostics-export-support-bundles.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- openclaw gateway diagnostics export: openclaw gateway diagnostics export and --json / --output / log-size options
- openclaw gateway stability --bundle: openclaw gateway stability --bundle latest --export
- Chat /diagnostics: Chat /diagnostics and /codex diagnostics approval flows
- Support zip composition: Support zip composition, safe relative paths, sanitized config/status/health/log/stability files, and privacy manifest
- Bounded in-process stability recorder: Bounded in-process stability recorder and diagnostics.stability RPC
- openclaw gateway stability: openclaw gateway stability, stability filtering, persisted stability bundles, and export-from-bundle
- Memory pressure events: Memory pressure events, event-loop liveness warnings, oversized payload events, queue/session summaries, and fatal/shutdown/restart snapshots
- Critical memory pressure snapshot option: Critical memory pressure snapshot option with V8/cgroup/session-file evidence

Primary docs:

- `docs/gateway/diagnostics.md`
- `docs/gateway/health.md`
- `docs/plugins/codex-harness.md`
- `docs/gateway/protocol.md`

### 4. Telemetry Export

Search anchors: diagnostic events, W3C trace context, hook context trace fields, diagnostics-otel, OTLP/HTTP traces, traceparent, diagnostics-prometheus, /api/diagnostics/prometheus, Prometheus text exposition.

Category note: [Telemetry Export](diagnostic-events-hooks-and-trace-context.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (78%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Diagnostic event types: Diagnostic event types and trusted/internal/public subscription boundaries
- Async dispatch: Async dispatch, queue saturation summaries, immutable event copies, private data handling, and diagnostics enablement
- W3C trace context creation: W3C trace context creation, active request scopes, child spans, and trusted traceparent formatting
- Plugin SDK diagnostic runtime exports: Plugin SDK diagnostic runtime exports and hook context trace fields
- Model-call diagnostic events: Model-call, tool, exec, webhook, message, Talk, session, harness, and exporter diagnostic events.
- diagnostics-otel plugin install: diagnostics-otel plugin install, enablement, config, env overrides, sampling, flush interval, and preloaded SDK mode
- OTLP/HTTP traces: OTLP/HTTP traces, metrics, and logs
- Trusted trace context: Trusted trace context, W3C traceparent propagation to model calls, file-log correlation, content-capture controls, and redacted/bounded attributes
- Model and runtime telemetry: Model, tool, message, session, queue, Talk, exec, webhook, context assembly, harness, and exporter-health signals
- diagnostics-prometheus plugin install: diagnostics-prometheus plugin install and enablement
- Gateway-authenticated GET /api/diagnostics/prometheus: Gateway-authenticated GET /api/diagnostics/prometheus behavior, status, and operator-visible verification.
- Prometheus text exposition: Prometheus text exposition, counters, gauges, histograms, label policy, series cap, and overflow metric
- Trusted diagnostic event subscription: Trusted diagnostic event subscription and rendering of run, model, tool, message, Talk, queue, session, liveness, payload, memory, and exporter metrics

Primary docs:

- `docs/plugins/hooks.md`
- `docs/gateway/opentelemetry.md`
- `docs/logging.md`
- `docs/plugins/sdk-subpaths.md`
- `docs/plugins/reference/diagnostics-otel.md`
- `docs/gateway/prometheus.md`
- `docs/plugins/reference/diagnostics-prometheus.md`

### 5. Session Diagnostics

Search anchors: session.state, usage diagnostics, stability export.

Category note: [Session Diagnostics](session-run-and-usage-diagnostics.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- session.state: session.state, session.stuck, session.long_running, session.stalled, session.recovery.\*, and session.turn.created diagnostic events
- Diagnostic session activity snapshots: Diagnostic session activity snapshots for embedded runs, model calls, and tool calls
- Model usage: Model usage, token/cost, model-call byte/timing, run attempts, and usage logs
- Export of session signals to stability: Export of session signals to stability, OpenTelemetry, and Prometheus

Primary docs:

- `docs/gateway/opentelemetry.md`
- `docs/gateway/prometheus.md`
- `docs/gateway/diagnostics.md`
- `docs/gateway/protocol.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/telemetry-diagnostics-and-observability/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/telemetry-diagnostics-and-observability`.
