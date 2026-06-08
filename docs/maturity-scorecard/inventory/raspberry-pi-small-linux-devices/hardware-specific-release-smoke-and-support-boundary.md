---
title: "Raspberry Pi / small Linux devices - Hardware Support Boundary Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - Hardware Support Boundary Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Hardware-specific Release Smoke and Support Boundary` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Raspberry Pi / small Linux devices capability area represented by these taxonomy features:

- Hardware-specific Release Smoke and Support Boundary: Evidence scope for Hardware-specific Release Smoke and Support Boundary.

## Features

- Supported Pi model selection: Defines Supported Pi model selection setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- 64-bit ARM boundary: Defines 64-bit ARM boundary setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Unsupported device guidance: Defines Unsupported device guidance setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Slow-device caveats: Defines Slow-device caveats setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (55%)`
- Positive signals: Raspberry Pi docs provide a real support boundary for model tiers, RAM, storage, OS architecture, Node, swap, local LLM avoidance, and ARM binary caveats.
- Negative signals: No recurring hardware smoke, release gate, or checked-in artifact was found for Pi 4, Pi 5, Pi Zero, or Pi OS.
- Integration gaps: Docker arm64 smoke is not the same as hardware smoke for SD-card I/O, RAM pressure, systemd boot persistence, Tailscale, channel runtime, or native helper binaries.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: searches for hardware smoke did not find a positive release gate, while related Pi issues continue to appear.
- Discrawl reports: real users operate OpenClaw on Pi devices and hit performance, pairing, auth, QMD/native, and package-manager issues.
- Good qualities: The documented support boundary is honest about Pi Zero, Pi 3B+, memory, storage, and local LLM limits.
- Bad qualities: Without a release signal, quality claims for this surface depend on generic Linux plus anecdotal Pi usage.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Alpha (55%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Supported Pi model selection, 64-bit ARM boundary, Unsupported device guidance, Slow-device caveats.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No inspected workflow proves install, daemon boot, Gateway readiness, Control UI access, auth, and one channel on Pi hardware.
- No scorecard-owned artifact records Pi model, OS image, architecture, RAM, storage, Node version, and OpenClaw version from a smoke run.
- No recurring issue triage label or release checklist was found for small Linux devices.

## Evidence

### Docs

- `docs/install/raspberry-pi.md:12-24` lists Pi 5, Pi 4 memory tiers, Pi 3B+, Pi Zero 2 W, and minimum/recommended hardware.
- `docs/install/raspberry-pi.md:26-33` requires 64-bit Raspberry Pi OS or Debian/Ubuntu ARM64.
- `docs/install/raspberry-pi.md:193-196` states the ARM64 caveat for optional Go/Rust CLI tools.
- `docs/help/faq-first-run.md:158-178` gives a broad Pi support answer and practical tips.
- `docs/help/faq.md:833-842` presents a common pattern of one Gateway on a Raspberry Pi plus nodes and agents elsewhere.
- `docs/help/faq.md:969-978` says small VPS/Pi-class boxes can host Gateway while laptop/phone nodes provide local tools.

### Source

- `scripts/test-install-sh-docker.sh:16-34` can choose a `linux/arm64` Docker smoke platform, but source inspection did not show a real Pi hardware target.
- `scripts/install.sh:144-150` recognizes ARM architectures.
- `scripts/install-cli.sh:338-346` supports arm64/aarch64 and x64 local-prefix Node paths.

### Integration tests

- `package.json:1735` and `package.json:1738` define installer e2e/smoke scripts.
- `package.json:1778` defines startup-memory checks.
- No Pi hardware release smoke script or recorded artifact was found.

### Unit tests

- Unit tests cover pieces of Linux/ARM-relevant behavior such as OOM wrapping, but no unit test can substitute for hardware smoke.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "hardware smoke Raspberry Pi release OpenClaw"`

Results:

- No matching threads returned.

Query: `gitcrawl search openclaw/openclaw --json --query "small Linux device OpenClaw"`

Results:

- Returned general Linux and platform discussions, but no focused small-device release gate.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi OpenClaw"`

Results:

- Found user and contributor reports of intended and actual Raspberry Pi usage, including Pi 3B+ and 2GB Pi 4.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Pi 5 aarch64 OpenClaw gateway"`

Results:

- Found Pi 5/aarch64 support issues around latency, install crashes, Gateway handshakes, QMD/native behavior, and plugin CPU load.
