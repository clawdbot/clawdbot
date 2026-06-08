---
title: CLI - CLI Observability Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI - CLI Observability Maturity Note

## Summary

OpenClaw exposes strong operator-facing observability through `status`, `health`,
`logs`, gateway stability, and diagnostics export paths. Coverage is solid
because the docs and command implementations are broad; quality is better than
average but still held back by hang reports and mixed-state clarity issues.

## Category Scope

This category covers read-oriented observability commands and shareable support
diagnostics. It does not cover doctor repair actions or gateway lifecycle
mutation commands.

## Features

- Status snapshots: openclaw status and related flags summarize runtime state, config health, and update context.
- Health snapshots: openclaw health gives a fast gateway health read and supports verbose or JSON output.
- Remote log tailing: openclaw logs tails gateway logs over RPC, including follow mode and JSON output.
- Diagnostics export: Gateway diagnostics bundles can be exported locally for bug reports and support workflows.
- Support-safe redaction: Diagnostics and status paths document privacy and redaction expectations before sharing results.

## Archive Freshness

- gitcrawl: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`, `api_supported=false`, `github_token_present=false`.
- discrawl: `generated_at=2026-05-30T01:10:41Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - `docs/cli/status.md`, `docs/cli/health.md`, `docs/cli/logs.md`, and `docs/gateway/diagnostics.md` document the operator flows clearly.
  - Status and health implementations are substantial in `src/commands/status.ts`, `src/commands/status.scan.ts`, `src/commands/status.summary.ts`, and `src/commands/health.ts`.
  - Gateway diagnostics and stability paths are implemented through `src/cli/gateway-cli/register.ts` and gateway RPC methods under `src/gateway/server-methods/diagnostics.ts`.
  - The status surface has extensive JSON and fast-path coverage in its test files.
- Negative signals:
  - Observability command breadth increases the chance of mismatches between fast paths, deep paths, and gateway-probe paths.
  - Logs and diagnostics span both CLI and gateway implementation layers.
- Integration gaps:
  - No broad CLI e2e suite was found that drives status, health, logs, and diagnostics export together against a live gateway.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports:
  - Query `gitcrawl search issues "status health logs diagnostics" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned open issues including `#42252 Improve doctor/gateway diagnostics clarity for mixed LaunchAgent/runtime states` and `#84012 openclaw status CLI command hangs before connecting to gateway`.
- Discrawl reports:
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw status health logs diagnostics"` returned maintainer incident checklists that depend on `gateway diagnostics export`, `gateway stability`, `health`, `gateway status --json`, and `logs`.
  - Archive results also include successful diagnostics-export examples with redacted bundle contents and support instructions.
- Good qualities:
  - Read-only versus deep status paths are documented explicitly.
  - Diagnostics export has a clear privacy/redaction story.
  - Operators have several paths to gather bounded support evidence without manual filesystem spelunking.
- Bad qualities:
  - Status hangs and mixed-state clarity are still active problem areas.
  - The observability surface spans enough modes that some operator confusion remains inevitable.
- Excluded from quality:
  - The status, health, and diagnostics test suites below contribute to coverage only.

## Known Gaps

- No single live CLI e2e for the whole support bundle path was found.
- Mixed-state messaging between status, doctor, and managed-service reality is still under pressure.

## Evidence

### Docs

- `docs/cli/status.md`
- `docs/cli/health.md`
- `docs/cli/logs.md`
- `docs/gateway/diagnostics.md`

### Source

- `src/commands/status.ts`
- `src/commands/status.scan.ts`
- `src/commands/status.summary.ts`
- `src/commands/health.ts`
- `src/cli/gateway-cli/register.ts`
- `src/gateway/server-methods/diagnostics.ts`

### Integration tests

- None found for a full live support-bundle CLI flow.

### Unit tests

- `src/commands/status-json-runtime.test.ts`
- `src/commands/status.scan.test.ts`
- `src/commands/status.scan.fast-json.test.ts`
- `src/commands/status.service-summary.test.ts`
- `src/commands/health.test.ts`
- `src/gateway/server-methods/diagnostics.test.ts`

### Surface validation commands

- `none declared in taxonomy`: `pass` - CLI surface does not declare extra validation commands for scoring.

### Gitcrawl queries

Query:

- `gitcrawl search issues "status health logs diagnostics" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`

Results:

- `[{"number":44297,"state":"open","title":"Surface Slack external arg-menu fallback as a visible health signal","url":"https://github.com/openclaw/openclaw/issues/44297"},{"number":86599,"state":"open","title":"[Bug]: Local model provider calls thread block gateway event loop on Windows beta; trivial infer run takes ~4 minutes","url":"https://github.com/openclaw/openclaw/issues/86599"},{"number":42252,"state":"open","title":"Improve doctor/gateway diagnostics clarity for mixed LaunchAgent/runtime states","url":"https://github.com/openclaw/openclaw/issues/42252"},{"number":48104,"state":"open","title":"Model safety/alignment can block explicitly authorized operational tasks (e.g. SSH diagnostics)","url":"https://github.com/openclaw/openclaw/issues/48104"},{"number":84012,"state":"open","title":"openclaw status CLI command hangs before connecting to gateway (v2026.5.18)","url":"https://github.com/openclaw/openclaw/issues/84012"}]`

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw status health logs diagnostics"`

Results:

- Maintainer incident guidance depends on this surface for first-line debugging.
- Archive examples show diagnostics export producing sanitized bundles with status, health, logs, and stability snapshots for support workflows.
