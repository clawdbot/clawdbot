---
title: "Raspberry Pi / small Linux devices - Package Manager and ARM Binary Compatibility Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - Package Manager and ARM Binary Compatibility Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Package Manager and Arm Binary Policy` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Raspberry Pi / small Linux devices capability area represented by these taxonomy features:

- Package Manager and Arm Binary Policy: Evidence scope for Package Manager and Arm Binary Policy.

## Features

- npm/pnpm/Bun install modes: Defines npm/pnpm/Bun install modes setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Installer architecture detection: Defines Installer architecture detection setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Optional ARM binary checks: Defines Optional ARM binary checks setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Fallback/build guidance: Defines Fallback/build guidance setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: Install docs define Node as the Gateway runtime, allow npm/pnpm/Bun entrypoints, and warn that Bun is not recommended for Gateway. Raspberry Pi docs explicitly warn that optional Go/Rust CLI tools may not ship ARM builds.
- Negative signals: Package-manager policy is spread across generic install docs, platform docs, and Raspberry Pi notes. Optional native binary handling is mostly a caution rather than a discoverable compatibility table.
- Integration gaps: Install smoke validates the general npm artifact, but there is no found ARM-native binary matrix or Pi-specific package-manager smoke.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: archive hits include npm install confusion on Raspberry Pi and ARM/low-memory toolchain problems.
- Discrawl reports: QMD, native binary, and ARM packaging threads show repeated Pi 5/aarch64 timeouts and missing or slow native behavior.
- Good qualities: Docs make Node the conservative path and explicitly warn about ARM binary variance.
- Bad qualities: Users still encounter native/bundled binary problems after installation, and the docs do not centralize which optional features are safe on arm64.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for npm/pnpm/Bun install modes, Installer architecture detection, Optional ARM binary checks, Fallback/build guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No inspected compatibility table lists optional tools by `linux-arm64`, `aarch64`, `armv7`, or `armv6`.
- Bun support is documented as possible for CLI installation but not recommended for Gateway runtime, which can still be confusing on small devices.
- Package-manager diagnostics do not appear to preflight optional native binary availability.

## Evidence

### Docs

- `docs/platforms/linux.md:10-12` says Gateway is fully supported on Linux with Node.js recommended and Bun not recommended.
- `docs/install/index.md:68-106` documents npm, pnpm, and Bun install modes while keeping Node recommended for Gateway runtime.
- `docs/install/raspberry-pi.md:193-196` says most features work on ARM64, but optional Go/Rust CLI tools may not ship ARM builds and operators should verify `linux-arm64`/`aarch64`.
- `docs/install/installer.md:241-254` documents installer flags for Node version and npm prefix on Linux.

### Source

- `scripts/install-cli.sh:338-346` accepts only `arm64`/`aarch64` and `x64` for the local-prefix Node tarball path.
- `scripts/install-cli.sh:391-431` links a local Node runtime and verifies `node:sqlite`.
- `scripts/install.sh:1746-1781` handles Alpine Linux Node install and checks Node >=22.19.
- `src/daemon/service-env.ts:169-195` carries package-manager bin locations such as npm prefix, pnpm, Bun, and user-local paths into service environments.
- `src/daemon/service-env.ts:300-330` resolves Linux user bin paths including `.local`, `.npm-global`, `.bun`, `.nix-profile`, and pnpm.

### Integration tests

- `scripts/docker/install-sh-e2e/run.sh:121-144` exercises installer output against the built npm artifact.
- `scripts/docker/install-sh-smoke/run.sh` performs installer smoke validation.
- No inspected integration test validates optional ARM-native plugin or helper binaries on Raspberry Pi hardware.

### Unit tests

- Unit coverage was not found for ARM optional binary policy.
- Service environment tests indirectly cover package-manager path propagation, but not Pi package-manager semantics.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "ARM binary linux-arm64 aarch64 OpenClaw skill"`

Results:

- No matching threads returned.

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi low memory OpenClaw"`

Results:

- Returned Raspberry Pi npm global install confusion and ARM/low-memory related reports.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "ARM binary OpenClaw"`

Results:

- Found reports that OpenClaw CLI is painfully slow on Raspberry Pi, QMD ARM/Pi 5 timeouts, Oracle ARM native binary conflicts, and QMD binary gaps on ARM platforms.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi QMD memory OpenClaw"`

Results:

- Found a Pi 5 aarch64 QMD embed timeout loop with node-llama-cpp build churn and a workaround using BM25/search mode.
