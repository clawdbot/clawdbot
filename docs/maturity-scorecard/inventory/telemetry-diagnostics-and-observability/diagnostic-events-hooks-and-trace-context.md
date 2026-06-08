---
title: "Observability - Telemetry Export Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Telemetry Export Maturity Note

## Summary

The diagnostic event bus is the internal telemetry contract behind stability, OTEL, Prometheus, hooks, model-call timing, and file-log correlation. It is broad and carefully guarded, but the event catalog is still evolving as new AI safety, quality, and plugin observability requests appear.

## Category Scope

Included in this category:

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

## Features

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

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: The event bus, trace context, plugin SDK exports, model-call events, hook trace propagation, and exporter consumers have focused tests.
- Negative signals: Coverage is spread across many producers and consumers, so each new event family needs explicit smoke and redaction checks.
- Integration gaps: Third-party plugin hook traces and end-to-end provider trace propagation need more repeatable scenario proof.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: Issue #82548 asks for more AI safety and quality observability events, implying the event inventory is still not final.
- Discrawl reports: Archive summaries call the diagnostics event bus the source of truth and mention follow-up fixes for Talk metrics, message label bounding, manifest diagnostics, and unreachable status diagnostics.
- Good qualities: The bus isolates listener failures, guards recursion, freezes trace contexts, separates trusted/private metadata, and drops high-volume events asynchronously with bounded summaries.
- Bad qualities: Event taxonomy growth can create operator ambiguity unless docs, exporters, and privacy controls stay aligned.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Diagnostic event types, Async dispatch, W3C trace context creation, Plugin SDK diagnostic runtime exports, Model-call diagnostic events, diagnostics-otel plugin install, OTLP/HTTP traces, Trusted trace context, Model and runtime telemetry, diagnostics-prometheus plugin install, Gateway-authenticated GET /api/diagnostics/prometheus, Prometheus text exposition, Trusted diagnostic event subscription.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Public plugin-author guidance does not yet enumerate every diagnostic event family and privacy boundary in one place.
- AI safety and quality signal requests need to be reconciled with the existing diagnostics event model.

## Evidence

### Docs

- `docs/plugins/hooks.md` documents hook context fields including `ctx.trace`, `ctx.traceId`, `ctx.spanId`, and `ctx.parentSpanId`.
- `docs/gateway/opentelemetry.md` explains diagnostics events as structured in-process records and describes trusted provider `traceparent`.
- `docs/logging.md` documents trace correlation through file logs and diagnostic events.
- `docs/plugins/sdk-subpaths.md` lists `plugin-sdk/diagnostic-runtime` and `plugin-sdk/logging-core`.

### Source

- `src/infra/diagnostic-events.ts` defines event types, dispatch, trust metadata, private data, async queue behavior, diagnostics enablement, and subscribers.
- `src/infra/diagnostic-trace-context.ts` implements W3C trace context parsing, formatting, active async scopes, and child contexts.
- `src/plugin-sdk/diagnostic-runtime.ts` exports diagnostic helpers to plugins.
- `src/gateway/server-http.ts` and `src/gateway/server/ws-connection/message-handler.ts` create request trace scopes for HTTP and WS flows.
- `src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.ts` emits trusted model-call events and provider `traceparent`.

### Integration tests

- `src/agents/agent-tools.before-tool-call.e2e.test.ts` and `src/agents/agent-tools.before-tool-call.integration.e2e.test.ts` capture diagnostic events around tool hooks.
- `src/gateway/server-http.request-trace.test.ts` exercises request trace scopes through gateway HTTP handling.
- `scripts/qa-otel-smoke.ts` validates exported traces and leak checks from diagnostic events.

### Unit tests

- `src/infra/diagnostic-events.test.ts` covers event sequencing, listener isolation, trust/provenance, immutable copies, async queues, drop summaries, private data, disabled diagnostics, and recursion guards.
- `src/infra/diagnostic-trace-context.test.ts` covers traceparent parsing/formatting, malformed inputs, child contexts, freezing, and async scope propagation.
- `src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.test.ts` covers model-call event emission and trusted traceparent propagation.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "diagnostic events trace context plugin hooks telemetry" --limit 5`

Results:

- 1 hit. Issue #82548 references missing trace context for observability in plugin hooks and response quality diagnostics as part of requested AI safety and quality observability events.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "diagnostic events trace context plugin hooks telemetry"`

Results:

- 1 hit. The archive summarizes the diagnostics event bus as the source of truth for model calls, tool execution, exec processes, message flow, outbound delivery, hooks, memory, harness lifecycle, queues, sessions, and recovery, with trace context carried through hooks and provider calls.
