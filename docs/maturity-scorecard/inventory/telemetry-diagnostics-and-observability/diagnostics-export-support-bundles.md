---
title: "Observability - Diagnostic Collection Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Diagnostic Collection Maturity Note

## Summary

Diagnostics export is the shareable bug-report path for local operators and chat-command users. It collects sanitized config shape, log summaries, status and health snapshots, stability bundles, manifests, and privacy notes. The privacy model is explicit, but archive evidence includes at least one review finding about Windows path redaction, keeping quality below Stable.

## Category Scope

Included in this category:

- openclaw gateway diagnostics export: openclaw gateway diagnostics export and --json / --output / log-size options
- openclaw gateway stability --bundle: openclaw gateway stability --bundle latest --export
- Chat /diagnostics: Chat /diagnostics and /codex diagnostics approval flows
- Support zip composition: Support zip composition, safe relative paths, sanitized config/status/health/log/stability files, and privacy manifest
- Bounded in-process stability recorder: Bounded in-process stability recorder and diagnostics.stability RPC
- openclaw gateway stability: openclaw gateway stability, stability filtering, persisted stability bundles, and export-from-bundle
- Memory pressure events: Memory pressure events, event-loop liveness warnings, oversized payload events, queue/session summaries, and fatal/shutdown/restart snapshots
- Critical memory pressure snapshot option: Critical memory pressure snapshot option with V8/cgroup/session-file evidence

## Features

- openclaw gateway diagnostics export: openclaw gateway diagnostics export and --json / --output / log-size options
- openclaw gateway stability --bundle: openclaw gateway stability --bundle latest --export
- Chat /diagnostics: Chat /diagnostics and /codex diagnostics approval flows
- Support zip composition: Support zip composition, safe relative paths, sanitized config/status/health/log/stability files, and privacy manifest
- Bounded in-process stability recorder: Bounded in-process stability recorder and diagnostics.stability RPC
- openclaw gateway stability: openclaw gateway stability, stability filtering, persisted stability bundles, and export-from-bundle
- Memory pressure events: Memory pressure events, event-loop liveness warnings, oversized payload events, queue/session summaries, and fatal/shutdown/restart snapshots
- Critical memory pressure snapshot option: Critical memory pressure snapshot option with V8/cgroup/session-file evidence

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Export composition, redaction, snapshot failure handling, CLI export, and chat-command initiation have focused tests.
- Negative signals: Full chat-command-to-approved-export proof is narrower than local CLI export proof.
- Integration gaps: Support-bundle flows should be re-run on macOS, Linux, Windows path shapes, and group-chat private routing.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: The exact query found a plugin bundle support diagnostic item rather than a direct export defect.
- Discrawl reports: A review comment on PR #70324 found case-sensitive Windows path-prefix redaction in support exports, which is a concrete privacy quality risk.
- Good qualities: The exporter uses safe zip paths, mode-restricted file writes, redaction helpers, sanitized snapshots, and manifest privacy notes.
- Bad qualities: Support artifacts are sensitive by nature, and redaction correctness must be maintained across OS path conventions and newly added snapshot fields.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw gateway diagnostics export, openclaw gateway stability --bundle, Chat /diagnostics, Support zip composition, Bounded in-process stability recorder, openclaw gateway stability, Memory pressure events, Critical memory pressure snapshot option.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The docs warn users to review bundles, but the first-stop runbook could include more examples for inspecting export contents before sharing.
- Windows path and username redaction needs sustained review because this path is designed for support sharing.

## Evidence

### Docs

- `docs/gateway/diagnostics.md` documents CLI export, chat command, support zip contents, privacy model, stability recorder, useful options, and disabling diagnostics.
- `docs/gateway/health.md` points bug reports to `openclaw gateway diagnostics export`.
- `docs/plugins/codex-harness.md` links Codex harness diagnostics to the Gateway export boundary.

### Source

- `src/logging/diagnostic-support-export.ts` builds manifests, config shape, sanitized logs, snapshots, and stability bundle files.
- `src/logging/diagnostic-support-bundle.ts` writes safe support bundle files and zip archives.
- `src/logging/diagnostic-support-redaction.ts` and `src/logging/diagnostic-support-log-redaction.ts` sanitize strings, paths, logs, and snapshots.
- `src/cli/gateway-cli/register.ts` wires `openclaw gateway diagnostics export` and stability export.
- `src/auto-reply/reply/commands-diagnostics.ts` implements `/diagnostics` private routing and approval behavior.

### Integration tests

- `src/cli/gateway-cli.coverage.test.ts` exercises gateway diagnostics export with best-effort health snapshots.
- `src/agents/bash-tools.exec-host-gateway.test.ts` includes the exec command path for `openclaw gateway diagnostics export --json`.

### Unit tests

- `src/logging/diagnostic-support-export.test.ts` verifies shareable zip output, omission of raw chats/webhook bodies/secrets, imported stability bundle sanitization, snapshot failure tolerance, and path redaction.
- `src/logging/diagnostic-support-bundle.test.ts` verifies safe bundle paths and writing.
- `src/auto-reply/reply/commands-diagnostics.test.ts` verifies chat diagnostics command behavior.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "gateway diagnostics export support bundle redaction" --limit 5`

Results:

- 1 hit. PR #87141 mentions bundle server-inspection support and diagnostics hardening; no direct active export bug was returned by this exact query.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "gateway diagnostics export support bundle redaction"`

Results:

- 1 hit. A 2026-04-22 review comment on PR #70324 reported that `redactKnownPathPrefixesForSupport` matched Windows path prefixes case-sensitively, risking local profile path/username leaks when casing differs.
