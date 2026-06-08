---
title: "Raspberry Pi / small Linux devices - Setup and Compatibility Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - Setup and Compatibility Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Arm Linux Install and Runtime Prerequisites` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Hardware and 64-bit OS requirements: Defines Hardware and 64-bit OS requirements setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- Node runtime setup: Defines Node runtime setup setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- OpenClaw install and onboarding: Defines OpenClaw install and onboarding setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- First-run verification: Defines First-run verification setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- Supported Pi model selection: Defines Supported Pi model selection setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- 64-bit ARM boundary: Defines 64-bit ARM boundary setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Unsupported device guidance: Defines Unsupported device guidance setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Slow-device caveats: Defines Slow-device caveats setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- npm/pnpm/Bun install modes: Defines npm/pnpm/Bun install modes setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Installer architecture detection: Defines Installer architecture detection setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Optional ARM binary checks: Defines Optional ARM binary checks setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Fallback/build guidance: Defines Fallback/build guidance setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.

## Features

- Hardware and 64-bit OS requirements: Defines Hardware and 64-bit OS requirements setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- Node runtime setup: Defines Node runtime setup setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- OpenClaw install and onboarding: Defines OpenClaw install and onboarding setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- First-run verification: Defines First-run verification setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- Supported Pi model selection: Defines Supported Pi model selection setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- 64-bit ARM boundary: Defines 64-bit ARM boundary setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Unsupported device guidance: Defines Unsupported device guidance setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Slow-device caveats: Defines Slow-device caveats setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- npm/pnpm/Bun install modes: Defines npm/pnpm/Bun install modes setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Installer architecture detection: Defines Installer architecture detection setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Optional ARM binary checks: Defines Optional ARM binary checks setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Fallback/build guidance: Defines Fallback/build guidance setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Raspberry Pi docs name supported models, RAM tiers, 64-bit OS, swap, Node 24 installation, first-run onboarding, verification commands, and persistence paths. Installer source detects Linux ARM variants and enforces Node minimums.
- Negative signals: 32-bit and older Pi boundaries are largely documented rather than enforced end to end, and the local-prefix installer only supports x64 plus arm64/aarch64 Node tarball selection.
- Integration gaps: Docker installer smoke can run on arm64, but there is no recurring real Raspberry Pi release smoke in the inspected paths.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: low-memory and ARM install issues exist, including npm global install confusion on Raspberry Pi and Linux arm64 systemd/session reports.
- Discrawl reports: users discuss installing on Pi 3B+, running on 2GB Pi 4, and setup on aarch64 devices such as Jetson Nano.
- Good qualities: Docs are practical and specific about Pi models, 64-bit OS, swap, and cloud models. Source has explicit ARM architecture detection and Node runtime guards.
- Bad qualities: Support boundaries are partly advisory; unsupported ARM/32-bit paths surface later as installer or binary errors instead of an up-front support matrix.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Hardware and 64-bit OS requirements, Node runtime setup, OpenClaw install and onboarding, First-run verification, Supported Pi model selection, 64-bit ARM boundary, Unsupported device guidance, Slow-device caveats, npm/pnpm/Bun install modes, Installer architecture detection, Optional ARM binary checks, Fallback/build guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No inspected source path maps every Pi generation and OS architecture to an explicit supported/unsupported policy.
- No hardware-labeled CI artifact was found for Pi 4, Pi 5, Pi Zero, or Pi OS.
- Local-prefix installer support is narrower than the Raspberry Pi docs imply for older or 32-bit devices.

## Evidence

### Docs

- `docs/install/raspberry-pi.md:10-24` describes an always-on Gateway on Raspberry Pi, names Pi 5 and Pi 4 tiers, marks Pi Zero 2 W as not recommended, and sets minimum and recommended hardware.
- `docs/install/raspberry-pi.md:26-33` lists prerequisites: Pi 4/5 with 2GB+, storage, power, network, 64-bit Raspberry Pi OS or Debian/Ubuntu ARM64, and 30 minutes.
- `docs/install/raspberry-pi.md:69-88` installs Node 24 through NodeSource and recommends swap for 2GB or less.
- `docs/install/index.md:10-14` states Node 24 or 22.19+ and macOS/Linux/Windows support.
- `docs/help/faq-first-run.md:158-178` says Raspberry Pi can run Gateway, recommends 2GB+, 64-bit OS, Node >=22, and warns about ARM binary issues.

### Source

- `scripts/install.sh:144-150` maps `arm64`, `aarch64`, `armv7`, and `armv6`.
- `scripts/install.sh:1472-1503` enforces the Node minimum version helpers.
- `scripts/install.sh:1784-1867` installs Linux Node through distro package managers and NodeSource-style flows.
- `scripts/install-cli.sh:338-346` supports `arm64`/`aarch64` and `x64` only for local-prefix tarball installs.
- `src/daemon/runtime-paths.ts:60-62` and `src/daemon/runtime-paths.ts:149-190` resolve Linux Node candidates and warn below the supported Node floor.

### Integration tests

- `scripts/test-install-sh-docker.sh:16-34` chooses `linux/arm64` smoke platform on Darwin arm64 hosts and `linux/amd64` in CI.
- `scripts/docker/install-sh-e2e/run.sh:121-144` runs the installer and verifies the installed CLI version.
- `package.json:1735` and `package.json:1738` define install e2e and install smoke scripts.

### Unit tests

- No Raspberry Pi specific installer unit test was found.
- Runtime Node path and service environment behavior is partly covered by daemon/runtime tests elsewhere, but not with Pi OS fixtures.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi ARM aarch64 arm64 Linux install Node openclaw"`

Results:

- No matching threads returned for the broad install query.

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi low memory OpenClaw"`

Results:

- Returned reports about adaptive resource limits for ARM/low-memory devices, Raspberry Pi OS arm64 discovery overhead, npm global install confusion on Raspberry Pi, and Linux arm64 systemd gateway state loss.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi OpenClaw"`

Results:

- Found a May 24 user asking about installing OpenClaw on a Pi 3B+ for WhatsApp automation and memory expectations.
- Found a May 21 report from a contributor running OpenClaw on a 2GB Pi 4.
- Found May 19 messaging that names Raspberry Pi as an always-on host option.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "aarch64 OpenClaw"`

Results:

- Found setup/debug threads on aarch64 systems, including minimal aarch64 environments missing Git and users checking `uname -m` plus Node versions.
