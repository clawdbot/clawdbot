---
title: "Observability - Prometheus Metrics Export Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Prometheus Metrics Export Maturity Note

## Summary

The Prometheus exporter is a focused pull-based metrics plugin with a protected gateway route, low-cardinality labels, a hard series cap, and broad coverage of run/model/tool/message/Talk/queue/session/memory/exporter metrics. It is younger than local logging and doctor surfaces, but its privacy and cardinality design is strong.

## Category Scope

- `diagnostics-prometheus` plugin install and enablement.
- Gateway-authenticated `GET /api/diagnostics/prometheus`.
- Prometheus text exposition, counters, gauges, histograms, label policy, series cap, and overflow metric.
- Trusted diagnostic event subscription and rendering of run, model, tool, message, Talk, queue, session, liveness, payload, memory, and exporter metrics.

## Features

- diagnostics-prometheus plugin install: diagnostics-prometheus plugin install and enablement
- Gateway-authenticated GET /api/diagnostics/prometheus: Gateway-authenticated GET /api/diagnostics/prometheus behavior, status, and operator-visible verification.
- Prometheus text exposition: Prometheus text exposition, counters, gauges, histograms, label policy, series cap, and overflow metric
- Trusted diagnostic event subscription: Trusted diagnostic event subscription and rendering of run, model, tool, message, Talk, queue, session, liveness, payload, memory, and exporter metrics

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: The exporter has unit tests, docs, plugin reference, QA-lab scenario identifiers, and Discord archive evidence of source-checkout smoke planning.
- Negative signals: Direct real Prometheus scrape proof is less visible than OTEL smoke proof.
- Integration gaps: The protected scrape route should be part of a recurring docker Prometheus smoke with auth and cardinality assertions.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports: The exact feature query returned no gitcrawl hits, so archive silence is neutral after freshness checks.
- Discrawl reports: The archive positively identifies the protected endpoint, 2048-series cap, low-cardinality policy, and privacy/cardinality work, with release notes pointing to `feat(diagnostics-prometheus): add protected metrics exporter`.
- Good qualities: The route uses gateway auth, drops untrusted plugin-emitted diagnostics, bounds labels, redacts values, drops session-shaped identifiers, and reports dropped series.
- Bad qualities: The public runbook still assumes the operator knows how to provide gateway auth to Prometheus and how to act on cardinality overflow.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for diagnostics-prometheus plugin install, Gateway-authenticated GET /api/diagnostics/prometheus, Prometheus text exposition, Trusted diagnostic event subscription.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No checked-in sample dashboard or alert pack exists for the documented PromQL recipes.
- Real Prometheus auth setup could use more tested examples beyond the docs snippet.

## Evidence

### Docs

- `docs/gateway/prometheus.md` documents the protected route, install/enable flow, scrape config, exported metrics, label policy, series cap, PromQL recipes, and choosing between Prometheus and OTEL.
- `docs/plugins/reference/diagnostics-prometheus.md` documents the plugin reference page.

### Source

- `extensions/diagnostics-prometheus/index.ts` registers the service and gateway-authenticated `/api/diagnostics/prometheus` route.
- `extensions/diagnostics-prometheus/src/service.ts` implements the metric store, text rendering, low-cardinality labels, 2048-series cap, trusted event filtering, event-to-metric mapping, and exporter diagnostic events.

### Integration tests

- `extensions/qa-lab/src/scenario-packs.ts` defines `docker-prometheus-smoke` in the source-checkout diagnostics smoke scenario pack.
- `extensions/qa-lab/src/coverage-report.test.ts` asserts that observability smoke coverage includes `telemetry.prometheus`.

### Unit tests

- `extensions/diagnostics-prometheus/src/service.test.ts` covers trusted run metrics, untrusted-event drops, label bounding, messaging/session/Talk/recovery metrics, series caps, and scrape text rendering.
- `src/wizard/setup.official-plugins.test.ts` includes official plugin setup choices for `diagnostics-prometheus`.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "diagnostics prometheus metrics exporter" --limit 5`

Results:

- 0 hits returned for the exact feature query.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "diagnostics prometheus metrics exporter"`

Results:

- 5 hits. Results summarize `GET /api/diagnostics/prometheus`, gateway auth, 2048-series cap, low-cardinality labels, run/model/tool/message/Talk/queue/session/memory/exporter metrics, freshbits release notes for `feat(diagnostics-prometheus): add protected metrics exporter`, and closure of metrics/observability support as implemented.
