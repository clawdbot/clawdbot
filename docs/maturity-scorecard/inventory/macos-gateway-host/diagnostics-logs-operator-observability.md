---
title: "macOS Gateway host - Diagnostics and Observability Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Diagnostics and Observability Maturity Note

## Summary

macOS Gateway host observability is strong. Operators have launchd stdout/stderr
paths, app diagnostics JSONL, `gateway status --deep`, doctor service/platform
checks, Gateway troubleshooting runbooks, ENETDOWN guidance, stale updater
checks, memory pressure diagnostics, and channel/service probes.

Coverage is Stable because docs/source/tests cover the major diagnostic
surfaces. Quality is Stable because the operator surfaces are specific and
actionable, though severe update/launchd failures still require multiple
commands and log locations.

## Category Scope

Included in this category:

- LaunchAgent log paths: LaunchAgent log paths and app diagnostic log paths
- openclaw gateway status --deep: openclaw gateway status --deep, gateway probe, doctor, health, and logs commands
- Gateway silently stops responding: Gateway silently stops responding, ENETDOWN sleep/wake failure, port conflicts, invalid config, and memory pressure runbooks
- Stale updater jobs: Stale updater jobs, service config drift, and LaunchAgent environment diagnostics

## Features

- LaunchAgent log paths: LaunchAgent log paths and app diagnostic log paths
- openclaw gateway status --deep: openclaw gateway status --deep, gateway probe, doctor, health, and logs commands
- Gateway silently stops responding: Gateway silently stops responding, ENETDOWN sleep/wake failure, port conflicts, invalid config, and memory pressure runbooks
- Stale updater jobs: Stale updater jobs, service config drift, and LaunchAgent environment diagnostics

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: docs cover command ladders and macOS-specific failures; source implements log locators and diagnostics JSONL; tests cover log paths, status diagnostics, stale stderr, launchctl env overrides, and stale updater cleanup.
- Negative signals: observability proof is broad but not packaged as one macOS support-bundle flow that captures every relevant log and status artifact.
- Integration gaps: need a release proof that injects launchd failure, ENETDOWN-like listener loss, stale updater job, and invalid config, then validates operator-facing diagnostics.

## Quality Score

- Score: `Stable (83%)`
- Gitcrawl reports: `gateway status deep macOS ENETDOWN stale updater memory pressure` returned no open hits, and the earlier diagnostics query for `macOS gateway diagnostics logs launchd stability ENETDOWN status deep` also returned no hits.
- Discrawl reports: `macOS gateway silently stops responding ENETDOWN` returned no printed hits, while launchd/update searches returned concrete status/deep-status support patterns that docs/source now address.
- Good qualities: docs are command-oriented, log paths are explicit, app diagnostics are JSONL with rotation, status gathers service/env/runtime/config/audit/probe details, and doctor has repair modes plus platform/service checks.
- Bad qualities: hard launchd/update incidents still require operators to combine `gateway status --deep`, doctor, launchctl, log files, stale updater cleanup, and app diagnostics manually.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for LaunchAgent log paths, openclaw gateway status --deep, Gateway silently stops responding, Stale updater jobs.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- A single macOS support bundle should collect app diagnostics, launchd stdout/stderr, `launchctl print`, `gateway status --deep`, doctor output, and stale updater state.
- Troubleshooting could link app diagnostics directly from the Gateway launchd runbook.
- ENETDOWN/sleep-wake guidance should be included in the main macOS host runbook, not only Gateway troubleshooting.

## Evidence

### Docs

- `docs/platforms/mac/bundled-gateway.md:50`: documents logs and version compatibility checks.
- `docs/platforms/macos.md:173`: documents debug CLI commands such as `openclaw-mac connect/discover`.
- `docs/cli/gateway.md:267`: documents `gateway status --deep`, RPC requirements, and config drift.
- `docs/cli/gateway.md:323`: documents `gateway probe`, warnings, and multiple Gateway detection.
- `docs/gateway/doctor.md:10`: documents doctor as a repair/migration tool.
- `docs/gateway/doctor.md:166`: documents Gateway, service, supervisor, runtime, and port-collision checks.
- `docs/gateway/troubleshooting.md:12`: gives an operator command ladder.
- `docs/gateway/troubleshooting.md:457`: documents macOS Gateway silently stops responding, ENETDOWN, launchd respawn gate, pmset, and watchdog guidance.
- `docs/gateway/troubleshooting.md:509`: documents memory pressure diagnostics.
- `docs/gateway/troubleshooting.md:545`: documents invalid config repair.

### Source

- `apps/macos/Sources/OpenClaw/LogLocator.swift:3`: defines log directories under `/tmp/openclaw` and Gateway stdout/log paths.
- `apps/macos/Sources/OpenClaw/LogLocator.swift:48`: resolves LaunchAgent log paths.
- `apps/macos/Sources/OpenClaw/DiagnosticsFileLog.swift:3`: defines JSONL diagnostic logging and rotation.
- `apps/macos/Sources/OpenClaw/DiagnosticsFileLog.swift:18`: stores diagnostics under `~/Library/Logs/OpenClaw/diagnostics.jsonl`.
- `apps/macos/Sources/OpenClaw/DiagnosticsFileLog.swift:34`: appends diagnostic records.
- `src/cli/daemon-cli/status.gather.ts:493`: gathers service command/env/runtime, config audit, CLI-vs-daemon config, port/probe URL, deep restart handoff, extra services, stale update launchd jobs, SecretRef probe auth, RPC health, stale PID health, and last error.
- `src/daemon/launchd.ts:291`: finds stale updater jobs.
- `src/daemon/launchd.ts:387`: parses service port from launchd program args/env.
- `src/daemon/launchd.ts:410`: emits GUI session bootstrap guidance.

### Integration tests

- `scripts/e2e/parallels/macos-smoke.ts:923`: runs `gateway status --deep --require-rpc` in a macOS guest.
- `scripts/e2e/parallels/macos-discord.ts:27`: runs doctor, Gateway restart, and channel probe as part of macOS Discord smoke.
- `src/daemon/launchd.integration.e2e.test.ts:246`: proves a launchd missing-bootstrap repair path.

### Unit tests

- `apps/macos/Tests/OpenClawIPCTests/LogLocatorTests.swift:6`: verifies app and LaunchAgent log path resolution.
- `src/daemon/restart-logs.test.ts:39`: verifies macOS LaunchAgent logs under `~/Library/Logs/openclaw`.
- `src/daemon/diagnostics.test.ts:23`: verifies launchd stderr suppression and stale stderr handling.
- `src/commands/doctor-platform-notes.launchctl-env-overrides.test.ts:19`: tests launchctl token override warnings and unset guidance.
- `src/commands/doctor-platform-notes.launchctl-env-overrides.test.ts:124`: tests stale updater job warning and cleanup.
- `src/cli/daemon-cli/status.gather.test.ts:455`: surfaces restart handoffs and stale updater launchd jobs in deep status.
- `src/cli/daemon-cli/status.gather.test.ts:616`: uses plugin-aware config validation in status gathering.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "macOS gateway diagnostics logs launchd stability ENETDOWN status deep" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

Query:

```bash
gitcrawl search issues "gateway status deep macOS ENETDOWN stale updater memory pressure" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "macOS gateway silently stops responding ENETDOWN"
```

Results:

- Command succeeded and returned no printed hits.

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "gateway service launchd"
```

Results:

- Returned support reports where `gateway status --deep`, launchd job state, stale update jobs, and service drift were central to operator diagnosis.
