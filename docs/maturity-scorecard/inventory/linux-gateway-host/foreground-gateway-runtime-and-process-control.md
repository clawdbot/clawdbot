---
title: "Linux Gateway host - Gateway Runtime and Service Control Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host - Gateway Runtime and Service Control Maturity Note

## Summary

Foreground Gateway runtime behavior is stable for normal operators. The CLI documents `openclaw gateway`, `openclaw gateway run`, bind/auth guards, restart signals, health/readiness probes, and log access; source code implements startup guards, lock handling, update handoff, and Linux child-process OOM tuning. Quality remains just inside stable because recent issues show some port/probe and restart-path edges, but the core runtime path is mature.

## Category Scope

Included in this category:

- Foreground Gateway Runtime: Covers Foreground Gateway Runtime user-facing controls, state display, navigation, and rendering behavior for Foreground Gateway Runtime and Process Control.
- Process Control: Covers Process Control user-facing controls, state display, navigation, and rendering behavior for Foreground Gateway Runtime and Process Control.
- Systemd User Service Lifecycle setup: Defines Systemd User Service Lifecycle setup setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle operation: Defines Systemd User Service Lifecycle operation setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle status: Defines Systemd User Service Lifecycle status setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle recovery: Defines Systemd User Service Lifecycle recovery setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.

## Features

- Foreground Gateway Runtime: Covers Foreground Gateway Runtime user-facing controls, state display, navigation, and rendering behavior for Foreground Gateway Runtime and Process Control.
- Process Control: Covers Process Control user-facing controls, state display, navigation, and rendering behavior for Foreground Gateway Runtime and Process Control.
- Systemd User Service Lifecycle setup: Defines Systemd User Service Lifecycle setup setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle operation: Defines Systemd User Service Lifecycle operation setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle status: Defines Systemd User Service Lifecycle status setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle recovery: Defines Systemd User Service Lifecycle recovery setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (83%)`
- Rationale: the foreground runtime is documented from CLI command through readiness checks, and source code covers startup guard, lock coordination, non-loopback auth safety, restart handling, and Linux process tuning.
- Gaps: docs and CLI references do not put all Linux foreground failure signatures in one place.

## Quality Score

- Score: `Stable (80%)`
- Rationale: the normal foreground path is coherent and guarded, but current archive evidence still shows recent fixes around startup races, restart tokens, and option mismatch.
- Excluded from Quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (83%)`
- Surface instructions: evaluated against `references/completeness/linux-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Foreground Gateway Runtime, Process Control, Systemd User Service Lifecycle setup, Systemd User Service Lifecycle operation, Systemd User Service Lifecycle status, Systemd User Service Lifecycle recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Align `gateway run`, health, and probe option handling so operators can reuse port/bind options consistently.
- Add a short Linux foreground troubleshooting table for lock, port-in-use, readiness, auth, and restart symptoms.

## Evidence

### Docs

- `docs/gateway/index.md:25-48` documents startup, status, logs, and a healthy baseline.
- `docs/gateway/index.md:71-83` describes the always-on Gateway runtime model, single port, loopback default, auth requirement, and config/env secret sources.
- `docs/cli/gateway.md:25-48` documents foreground aliases, startup guard behavior, non-loopback auth guard, IPv4 caveat, SIGUSR1 restart, and signal handling.
- `docs/cli/gateway.md:53-112` documents port, bind, auth, token/password, Tailscale, force, verbose, and log options.
- `docs/cli/gateway.md:130-170` documents profiling, startup/restart benchmarks, health probes, and WebSocket RPC checks.

### Source

- `src/cli/gateway-cli/run.ts:107-120` maps config errors to stable exit behavior and defines auth/Tailscale modes.
- `src/cli/gateway-cli/run.ts:223-232` blocks non-loopback bind without explicit auth.
- `src/cli/gateway-cli/run-loop.ts:59-97` waits for port readiness and a healthy child process.
- `src/cli/gateway-cli/run-loop.ts:99-123` coordinates the Gateway run loop with lock handling and lifecycle imports that survive package updates.
- `src/process/linux-oom-score.ts:3-27` documents the Linux child-process OOM-score policy and opt-out environment key.

### Integration tests

- `src/cli/gateway-cli/run.supervised-lock.test.ts` covers exit-code behavior and healthy systemd lock conflicts.
- `src/gateway/server-http.probe.test.ts` covers health and readiness probe behavior.
- `src/gateway/server/http-listen.test.ts` covers listen retry behavior on address-in-use errors.

### Unit tests

- `src/infra/gateway-lock.test.ts` covers lock behavior.
- `src/process/linux-oom-score.test.ts` covers Linux process wrapper decisions.
- `src/cli/gateway-run-argv.test.ts` covers gateway run argument construction.

### Gitcrawl queries

- Specific query `openclaw gateway run foreground Linux process lock port startup readiness` returned no hits.
- Broader query `gateway run` returned PR #83489 for a Gateway service startup race, issue #79100 for `gateway health/probe` rejecting `--port` while `gateway run` accepts it, PR #84334 for SIGUSR1 token handling on systemd restart, PR #82894 for runtime prewarm before ready, and PR #66735 for systemd self-restart handoff.

### Discrawl queries

- Query `gateway run port` found operator discussion of `wss://` requirements for iOS/VPS access, hosted loopback mappings, Docker compose exposing port 18789, and node run `--host`/`--port` examples.
