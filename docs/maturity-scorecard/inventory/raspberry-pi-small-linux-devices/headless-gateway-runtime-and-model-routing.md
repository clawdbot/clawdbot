---
title: "Raspberry Pi / small Linux devices - Gateway Runtime Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - Gateway Runtime Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Headless Gateway Runtime and Model Routing` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Always-on Gateway process: Defines Always-on Gateway process setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Cloud model configuration: Defines Cloud model configuration setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Channel startup: Defines Channel startup setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Gateway health/status: Defines Gateway health/status setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- User service install: Defines User service install setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- linger/boot persistence: Defines linger/boot persistence setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Service drop-ins: Defines Service drop-ins setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Restart tuning: Defines Restart tuning setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Status/log inspection: Defines Status/log inspection setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Backup/restore: Defines Backup/restore setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.

## Features

- Always-on Gateway process: Defines Always-on Gateway process setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Cloud model configuration: Defines Cloud model configuration setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Channel startup: Defines Channel startup setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Gateway health/status: Defines Gateway health/status setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- User service install: Defines User service install setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- linger/boot persistence: Defines linger/boot persistence setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Service drop-ins: Defines Service drop-ins setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Restart tuning: Defines Restart tuning setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Status/log inspection: Defines Status/log inspection setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Backup/restore: Defines Backup/restore setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Gateway docs define the always-on process, loopback default, auth requirement, startup modes, remote access, and health endpoints. Raspberry Pi docs explicitly steer operators to cloud models rather than local LLMs.
- Negative signals: Small-device channel workloads are documented by example but are not proven by a hardware release gate. Headless OAuth/API-key guidance exists but can still fail in long-lived systemd contexts.
- Integration gaps: Gateway runtime and startup have broad integration coverage, but no inspected test runs channel automation on Raspberry Pi hardware.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Raspberry Pi Telegram/systemd and plugin-loader reports show actual headless usage with edge failures.
- Discrawl reports: users describe Pi-based Telegram, WhatsApp, and local model/QMD attempts, including repeated auth and latency problems.
- Good qualities: The docs make the cloud-model choice clear and avoid implying that small Pi devices should run local LLMs.
- Bad qualities: Real operator reports still mix headless auth, channel setup, and small-device performance issues, so the runtime story is not yet stable for non-expert users.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Always-on Gateway process, Cloud model configuration, Channel startup, Gateway health/status, User service install, linger/boot persistence, Service drop-ins, Restart tuning, Status/log inspection, Backup/restore.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No hardware-labeled release proof was found for a Pi Gateway serving a channel connector over time.
- Channel-specific setup is not presented as a Pi-safe matrix.
- QMD/local model behavior on Pi is mostly represented through warnings and archive pain, not a crisp support boundary.

## Evidence

### Docs

- `docs/gateway/index.md:71-83` defines one always-on Gateway process, single port, loopback default, and auth requirements.
- `docs/gateway/index.md:135-147` lists operator command capabilities behind Gateway.
- `docs/cli/gateway.md:25-48` documents Gateway run/startup behavior, config guardrails, and non-loopback auth guards.
- `docs/install/raspberry-pi.md:174-191` recommends cloud-hosted API models and says not to run local LLMs on a Pi.
- `README.md:116-128` describes daemon mode versus foreground/debug mode.

### Source

- `src/cli/gateway-cli/run.ts:367-395` probes Gateway health while starting.
- `src/cli/gateway-cli/run-loop.ts:220-253` supports in-process restart fallback and `OPENCLAW_NO_RESPAWN`.
- `src/shared/gateway-bind-url.ts:21-46` resolves custom, tailnet, and LAN bind URLs.
- `src/commands/status.gateway-probe.ts:8-21` resolves Gateway probe auth.

### Integration tests

- `package.json:1731` defines the Gateway test suite.
- `package.json:1776` and `package.json:1777` define Gateway startup and restart benchmarks.
- No inspected integration path names Raspberry Pi hardware.

### Unit tests

- Gateway bind/auth/startup logic has targeted tests in the Gateway and CLI test suites, but not Pi fixtures.
- `scripts/check-cli-startup-memory.mjs:96-120` includes Gateway status startup-memory cases.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi WhatsApp Telegram gateway"`

Results:

- No focused thread returned for the combined WhatsApp/Telegram query.

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi low memory OpenClaw"`

Results:

- Returned plugin-loader and Raspberry Pi OS arm64 performance issues that affect headless Gateway use.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi Codex auth systemd"`

Results:

- Found a Pi/Linux systemd comment describing Telegram agents and repeated Codex OAuth failures.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Pi 5 aarch64 OpenClaw gateway"`

Results:

- Found Pi 5 aarch64 latency, npm install crash, QMD/native timeout, and CLI handshake timeout reports.
