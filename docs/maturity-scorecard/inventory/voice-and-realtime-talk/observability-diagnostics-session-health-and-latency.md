---
title: "Voice and realtime talk - Talk Observability Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Talk Observability Maturity Note

## Summary

Talk observability has concrete runtime plumbing: event logs, diagnostics records, session health, echo suppression tracking, live smoke output, and Prometheus-facing diagnostics. Coverage is beta-level. Quality reaches beta because the implementation avoids blocking runtime paths and captures provider/session health, but the original scorecard row still calls for latency, failure-mode, and setup scoring before beta promotion.

## Category Scope

Included in this category:

- Talk event logging: Talk event logging and diagnostics event mapping
- Session-log health: Session-log health, transcript records, bridge events, and echo/output suppression timing
- Live smoke output: Live smoke output and provider event inspection
- Prometheus diagnostic counters: Prometheus diagnostic counters for Talk events
- Operator visibility into setup: Operator visibility into setup, latency, and failure modes

## Features

- Talk event logging: Talk event logging and diagnostics event mapping
- Session-log health: Session-log health, transcript records, bridge events, and echo/output suppression timing
- Live smoke output: Live smoke output and provider event inspection
- Prometheus diagnostic counters: Prometheus diagnostic counters for Talk events
- Operator visibility into setup: Operator visibility into setup, latency, and failure modes

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`

Diagnostics, logs, session health, provider bridge events, Prometheus counters, and live smoke output cover most operator-observable runtime behavior. Coverage is not stable because latency and setup verification are not organized into a dedicated operator scorecard.

## Quality Score

- Score: `Beta (70%)`

Quality is supported by non-blocking logging, dropped high-volume delta events, structured diagnostic metadata, session health summaries, echo suppression state, and live smoke event checks. Quality is held at the beta floor because operator-facing setup, latency, and failure-mode visibility are still called out as missing maturity inputs.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Talk event logging, Session-log health, Live smoke output, Prometheus diagnostic counters, Operator visibility into setup.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No dedicated Talk latency scorecard was found.
- Setup and failure-mode paths are documented in pieces rather than one operator checklist.
- Archive search for Talk-specific latency diagnostics returned no relevant direct results.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:136` documents event log behavior in the Control UI.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:185` documents Talk mode status and live smoke invocation.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/voice-overlay.md:43` documents a debugging checklist with logging and overlay state.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:126` documents native notes, fallback, and validation details that affect operator diagnosis.

### Source

- `/Users/kevinlin/code/openclaw/src/talk/session-log-runtime.ts:29` tracks transcript and bridge event health.
- `/Users/kevinlin/code/openclaw/src/talk/session-log-runtime.ts:105` records echo suppression and output suppression timing.
- `/Users/kevinlin/code/openclaw/src/talk/diagnostics.ts:10` maps Talk events into diagnostic event metadata.
- `/Users/kevinlin/code/openclaw/src/talk/logging.ts:13` drops high-volume delta events and logs non-blocking event metadata.
- `/Users/kevinlin/code/openclaw/extensions/diagnostics-prometheus/src/service.ts` exposes Talk diagnostic metrics.
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts:148` covers OpenAI backend bridge, browser WebRTC, Google Live, and Gateway relay smoke paths.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/diagnostics-prometheus/src/service.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/talk/session-log-runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/diagnostics.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/logging.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/output-activity-tracker.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/turn-context-tracker.test.ts`

### Gitcrawl queries

- `gitcrawl search issues "talk diagnostics latency session log" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned no direct issue matches.
- `gitcrawl search issues "talk realtime voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned setup and provider issues relevant to failure visibility, including #83822, #84639, and #84664.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "talk diagnostics latency" --limit 5` returned no Talk-relevant direct results.
- `/Users/kevinlin/.local/bin/discrawl search "talk realtime voice" --limit 5` returned 2026-05-27 release notes saying realtime Talk runs can be inspected, steered, cancelled, and followed up.
- `/Users/kevinlin/.local/bin/discrawl search "OpenAI Realtime Talk Google Live" --limit 5` returned 2026-05-03 release notes saying realtime errors surface in Talk.
