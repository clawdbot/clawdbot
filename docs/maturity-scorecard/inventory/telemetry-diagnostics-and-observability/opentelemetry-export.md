---
title: "Observability - Opentelemetry Export Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Opentelemetry Export Maturity Note

## Summary

The OpenTelemetry exporter is a first-class diagnostics plugin that turns trusted OpenClaw diagnostic events into OTLP/HTTP traces, metrics, and logs. It has strong docs, configuration, privacy controls, trace context propagation, GenAI metric support, and a QA smoke harness. It is still fast-moving and has an open request for additional AI safety and quality observability events.

## Category Scope

- `diagnostics-otel` plugin install, enablement, config, env overrides, sampling, flush interval, and preloaded SDK mode.
- OTLP/HTTP traces, metrics, and logs.
- Trusted trace context, W3C `traceparent` propagation to model calls, file-log correlation, content-capture controls, and redacted/bounded attributes.
- Model, tool, message, session, queue, Talk, exec, webhook, context assembly, harness, and exporter-health signals.

## Features

- diagnostics-otel plugin install: diagnostics-otel plugin install, enablement, config, env overrides, sampling, flush interval, and preloaded SDK mode
- OTLP/HTTP traces: OTLP/HTTP traces, metrics, and logs
- Trusted trace context: Trusted trace context, W3C traceparent propagation to model calls, file-log correlation, content-capture controls, and redacted/bounded attributes
- Model and runtime telemetry: Model, tool, message, session, queue, Talk, exec, webhook, context assembly, harness, and exporter-health signals

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (83%)`
- Positive signals: The exporter has unit tests, a dedicated QA OTLP smoke harness, fixture tests, and docs for exact metrics/spans/log behavior.
- Negative signals: Collector/backend permutations are broad, and release proof is stronger for local OTLP receiver and mocked SDK paths than for every real backend.
- Integration gaps: Recurring smoke should include a real collector plus representative dashboards/alerts for traces, metrics, and logs.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: Issue #82548 requests additional AI safety and quality observability events, showing expected telemetry event inventory is still evolving.
- Discrawl reports: Discord archive summaries describe the OTEL pipeline as recently landed and split across multiple commits, with follow-up fixes through early May.
- Good qualities: The plugin drops high-cardinality identifiers, redacts attributes, gates content capture, handles unsupported protocols, reports exporter health, and prevents untrusted traceparent propagation.
- Bad qualities: The event catalog is still expanding, and operators need clearer "what to inspect first" guidance for real OTEL backends.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (83%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for diagnostics-otel plugin install, OTLP/HTTP traces, Trusted trace context, Model and runtime telemetry.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No public dashboard pack or alert baseline is documented alongside the exporter.
- AI safety and quality event requests indicate the signal catalog is not yet settled.

## Evidence

### Docs

- `docs/gateway/opentelemetry.md` documents OTLP/HTTP export, signals, config/env variables, privacy/content capture, sampling, metrics, traces, logs, and trace correlation.
- `docs/plugins/reference/diagnostics-otel.md` documents the plugin reference page.
- `docs/logging.md` documents trace correlation fields and model-call size/timing fields that feed OTEL.

### Source

- `extensions/diagnostics-otel/index.ts` registers the plugin service.
- `extensions/diagnostics-otel/src/service.ts` configures OpenTelemetry SDK/exporters, signal endpoints, sampling, preloaded SDK mode, content capture, metric/span/log mapping, low-cardinality attributes, and exporter diagnostic events.
- `src/infra/diagnostic-events.ts` and `src/infra/diagnostic-trace-context.ts` define diagnostic events and trace context.
- `src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.ts` emits model-call events and trusted provider `traceparent`.

### Integration tests

- `scripts/qa-otel-smoke.ts` runs a local OTLP receiver or real OpenTelemetry Collector and validates traces, metrics, logs, payload bounds, and content-leak checks.
- `test/scripts/qa-otel-smoke.test.ts` tests the smoke harness.
- `extensions/qa-lab/src/scenario-packs.ts` defines `otel-trace-smoke` as part of source-checkout diagnostics smoke scenarios.

### Unit tests

- `extensions/diagnostics-otel/src/service.test.ts` covers service startup, endpoints, preloaded SDK behavior, exporter errors, metrics/spans/log mapping, session recovery signals, redaction, and content controls.
- `src/infra/diagnostic-events.test.ts` and `src/infra/diagnostic-trace-context.test.ts` cover diagnostic dispatch, trust, async queues, and W3C trace context.
- `src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.test.ts` covers trusted model-call traceparent propagation and diagnostic events.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "diagnostics otel opentelemetry trace context metrics spans" --limit 5`

Results:

- 1 hit. Issue #82548 requests AI safety and quality observability events and references existing JSONL logs, trace correlation, diagnostics events, OpenTelemetry export, token/cost metrics, model-call timing, tool execution spans, and queue signals.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "diagnostics otel opentelemetry trace context metrics spans"`

Results:

- 3 hits. The archive summarizes a diagnostics-to-OTEL/Prometheus pipeline that landed around Apr 24-26, including trace context through hooks, trusted traceparent propagation, GenAI metrics/spans, optional content capture controls, exporter health diagnostics, and follow-up fixes.
