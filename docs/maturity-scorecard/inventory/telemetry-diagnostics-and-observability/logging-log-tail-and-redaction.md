---
title: "Observability - Logging Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Logging Maturity Note

## Summary

The logging surface is a strong operator tool: JSONL file logs, console styles, subsystem loggers, redaction, Control UI and CLI tailing, gateway RPC `logs.tail`, fallback behavior, and trace correlation are documented and implemented. The main quality risk is long-term consistency across every sink that can display logs or tool payloads.

## Category Scope

Included in this category:

- Rolling Gateway JSONL file logs: Rolling Gateway JSONL file logs and console output
- openclaw logs: openclaw logs, openclaw logs --follow, JSON/plain/color/timezone modes, and local fallback behavior
- Gateway RPC logs.tail: Gateway RPC logs.tail behavior, status, and operator-visible verification.
- Redaction patterns and sinks: console, file logs, OTLP log records, transcript text, Control UI tool-call events, support exports, and WS protocol logs
- Trace correlation fields: Trace correlation fields on log records and linked diagnostic events.

## Features

- Rolling Gateway JSONL file logs: Rolling Gateway JSONL file logs and console output
- openclaw logs: openclaw logs, openclaw logs --follow, JSON/plain/color/timezone modes, and local fallback behavior
- Gateway RPC logs.tail: Gateway RPC logs.tail behavior, status, and operator-visible verification.
- Redaction patterns and sinks: console, file logs, OTLP log records, transcript text, Control UI tool-call events, support exports, and WS protocol logs
- Trace correlation fields: Trace correlation fields on log records and linked diagnostic events.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Logging has dedicated docs, CLI tests, log-tail unit tests, redaction tests, transport tests, and RPC handler validation.
- Negative signals: There is less end-to-end proof of Control UI log rendering and remote tail behavior than of the core CLI/file-log path.
- Integration gaps: Remote gateway log following and systemd journal fallback are tested at the CLI unit level but need recurring real-host proof.

## Quality Score

- Score: `Stable (84%)`
- Gitcrawl reports: The main archive result is PR #74252, a log rotation reporting fix, which indicates active maintenance rather than a systemic logging failure.
- Discrawl reports: The exact feature query returned no direct Discord hits, so archive silence is neutral after freshness checks.
- Good qualities: The implementation bounds log tail reads, redacts before returning lines, validates RPC params, handles rotated files, and has explicit local fallback behavior.
- Bad qualities: Redaction policy spans many sinks, so regressions can appear when new diagnostic surfaces bypass the shared helpers.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Rolling Gateway JSONL file logs, openclaw logs, Gateway RPC logs.tail, Redaction patterns and sinks, Trace correlation fields.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Control UI log rendering is less directly represented in the proof trail than CLI and RPC log tailing.
- Operator docs could better cross-link targeted diagnostics flags from the main logging page.

## Evidence

### Docs

- `docs/logging.md` documents file logs, CLI tailing, Control UI logs, formats, log levels, targeted model transport diagnostics, trace correlation, and redaction.
- `docs/gateway/logging.md` documents gateway log surfaces, file logger configuration, console capture, WS log styles, and subsystem formatting.
- `docs/cli/logs.md` documents `openclaw logs` flags, local fallback, systemd journal fallback, and retry behavior.

### Source

- `src/logging/logger.ts`, `src/logging/subsystem.ts`, `src/logging/config.ts`, `src/logging/redact.ts`, and `src/logging/log-tail.ts` implement log creation, configuration, redaction, and tailing.
- `src/gateway/server-methods/logs.ts` exposes `logs.tail` with schema validation and bounded reads.
- `src/cli/logs-cli.ts` implements CLI formatting, local fallback, systemd journal fallback, and retry behavior.
- `src/gateway/ws-logging.ts` implements gateway WS protocol logging modes.

### Integration tests

- `src/cli/gateway-rpc.runtime.test.ts` maps `openclaw logs` to `logs.tail`.
- `src/cli/logs-cli.test.ts` exercises CLI fallback and follow retry behavior against mocked gateway/runtime boundaries.

### Unit tests

- `src/logging/log-tail.test.ts` verifies redaction and tail behavior.
- `src/logging/redact.test.ts`, `src/logging/logger-redaction-behavior.test.ts`, `src/logging/logger-settings.test.ts`, `src/logging/logger-transport.test.ts`, and `src/logging/parse-log-line.test.ts` cover core logging and redaction helpers.
- `src/gateway/server-methods/server-methods.test.ts` covers `logs.tail` RPC validation and responses.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "logging logs tail redaction request trace" --limit 5`

Results:

- 2 hits. PR #74252 fixes log rotation reporting, and PR #87141 includes plugin lifecycle trace logging hardening.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "logging logs tail redaction request trace"`

Results:

- 0 hits returned for the exact feature query.
