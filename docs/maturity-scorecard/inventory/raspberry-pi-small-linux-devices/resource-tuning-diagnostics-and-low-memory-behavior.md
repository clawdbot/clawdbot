---
title: "Raspberry Pi / small Linux devices - Performance and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - Performance and Diagnostics Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Resource Tuning, Diagnostics, and Low-memory Behavior` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Swap and low-RAM tuning: Defines Swap and low-RAM tuning setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- USB SSD guidance: Defines USB SSD guidance setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- Compile cache/no-respawn settings: Defines Compile cache/no-respawn settings setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- OOM/performance troubleshooting: Defines OOM/performance troubleshooting setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- Diagnostics bundles: Defines Diagnostics bundles setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.

## Features

- Swap and low-RAM tuning: Defines Swap and low-RAM tuning setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- USB SSD guidance: Defines USB SSD guidance setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- Compile cache/no-respawn settings: Defines Compile cache/no-respawn settings setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- OOM/performance troubleshooting: Defines OOM/performance troubleshooting setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- Diagnostics bundles: Defines Diagnostics bundles setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (75%)`
- Positive signals: Raspberry Pi docs include swap, USB SSD, compile cache, no-respawn mode, systemd drop-ins, cloud model guidance, troubleshooting, persistence, and backups. Linux source includes OOM score wrapping and startup optimization hints for ARM/low-memory hosts.
- Negative signals: Diagnostics and resource tuning are broad rather than Pi-specific, and archive results show repeated real-world Pi performance and QMD/native issues.
- Integration gaps: Startup memory checks and restart benchmarks exist, but there is no Pi hardware low-memory gate.

## Quality Score

- Score: `Alpha (69%)`
- Gitcrawl reports: adaptive resource limits, Raspberry Pi OS arm64 discovery overhead, local tsgo pressure guards, and plugin-loader skip reports show low-memory fixes are still active.
- Discrawl reports: Pi 5 aarch64 QMD embed timeout loops, Pi 5 latency, npm install crash, and CLI handshake timeout show recurring small-device pain.
- Good qualities: The source contains concrete mitigations: Linux child OOM score adjustment, compile-cache/no-respawn hints, and diagnostics bundles.
- Bad qualities: User-visible low-memory behavior remains fragile enough that support still recommends workarounds such as cloud models or BM25/search mode.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Beta (75%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Swap and low-RAM tuning, USB SSD guidance, Compile cache/no-respawn settings, OOM/performance troubleshooting, Diagnostics bundles.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No Pi 2GB or Pi 4GB performance target is enforced in CI.
- QMD/local embedding behavior on Pi is not captured in a crisp small-device support table.
- Startup memory checks are generic Linux/darwin thresholds, not Raspberry Pi hardware thresholds.

## Evidence

### Docs

- `docs/install/raspberry-pi.md:77-88` recommends swap for 2GB or less.
- `docs/install/raspberry-pi.md:133-148` recommends USB SSD, `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`, and `OPENCLAW_NO_RESPAWN=1`.
- `docs/install/raspberry-pi.md:150-172` gives memory-reducing systemd drop-ins and restart tuning.
- `docs/install/raspberry-pi.md:174-191` says not to run local LLMs on a Pi and to use hosted API models.
- `docs/install/raspberry-pi.md:212-220` troubleshoots OOM kills, slow performance, service start failure, and ARM binary issues.
- `docs/platforms/linux.md:101-135` documents memory pressure and OOM behavior.
- `docs/gateway/health.md:28-34` includes deep diagnostics with memory, liveness, stability bundles, and redaction.
- `docs/gateway/diagnostics.md:114-155` documents stability recorder and liveness warnings.
- `docs/gateway/diagnostics.md:192-205` documents optional pre-OOM memory snapshots.

### Source

- `src/process/linux-oom-score.ts:3-18` explains Linux child OOM score wrapping for long-lived Gateway operation.
- `src/process/linux-oom-score.ts:67-77` applies the wrapper only on Linux and when not disabled.
- `src/process/linux-oom-score.ts:98-115` wraps child spawn with `/proc/self/oom_score_adj`.
- `src/commands/doctor-platform-notes.ts:207-269` emits ARM/low-memory startup optimization hints for compile cache and `OPENCLAW_NO_RESPAWN`.
- `src/cli/gateway-cli/run-loop.ts:220-253` supports no-respawn/in-process restart fallback.

### Integration tests

- `scripts/check-cli-startup-memory.mjs:83-91` defines default RSS limits for Linux/darwin startup checks.
- `scripts/check-cli-startup-memory.mjs:96-120` includes help, status JSON, and Gateway status cases.
- `scripts/bench-gateway-restart.ts:38-46` records RSS in resource snapshots.
- `package.json:1778` defines the startup memory check.

### Unit tests

- `src/process/linux-oom-score.test.ts:13-18` verifies Linux child wrapping.
- `src/process/linux-oom-score.test.ts:28-40` verifies opt-out and no-shell behavior.
- `src/process/linux-oom-score.test.ts:58-70` verifies hardened environment behavior.
- `src/process/supervisor/adapters/pty.test.ts:246-272` verifies Linux PTY spawns are wrapped for OOM score.
- `src/process/supervisor/adapters/child.test.ts:423-437` verifies child wrappers strip shell environment.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi low memory OpenClaw"`

Results:

- Returned PR #47706 on adaptive resource limits for ARM/low-memory devices, issue #67288 on Raspberry Pi OS arm64 discovery overhead, PR #71652 on local tsgo pressure guards on Pi, and issue #78196 on plugins skipped by a Pi Gateway.

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi QMD memory OpenClaw"`

Results:

- Returned storage/performance-adjacent reports but no single focused QMD memory issue in gitcrawl.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi QMD memory OpenClaw"`

Results:

- Found a Pi 5 aarch64 QMD embed timeout loop, node-llama-cpp build churn, timeout mismatch discussion, and workaround guidance to use BM25/search mode.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Pi 5 aarch64 OpenClaw gateway"`

Results:

- Found Pi 5 aarch64 server-side latency, Pi500 aarch64 npm install crash, CLI handshake timeout, and high CPU from eager-loaded channel SDKs.
