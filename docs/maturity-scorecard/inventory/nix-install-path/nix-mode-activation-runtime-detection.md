---
title: "Nix install path - Activation and App UX Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - Activation and App UX Maturity Note

## Summary

OpenClaw has a simple and well-documented activation contract: `OPENCLAW_NIX_MODE=1` for Node/gateway paths and `openclaw.nixMode` defaults for the macOS app. The implementation is deliberately narrow and easy to reason about, but the proof is mostly unit-level and source-level rather than a full installed Nix runtime.

## Category Scope

Included in this category:

- Environment activation: Covers Environment activation across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- macOS defaults activation: Covers macOS defaults activation across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- Runtime Nix-mode detection: Covers Runtime Nix-mode detection across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- Stable Nix defaults: Covers Stable Nix defaults across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Managed-by-Nix banner: Covers Managed-by-Nix banner across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Read-only config controls: Covers Read-only config controls across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Onboarding skip: Covers Onboarding skip across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.

## Features

- Environment activation: Covers Environment activation across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- macOS defaults activation: Covers macOS defaults activation across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- Runtime Nix-mode detection: Covers Runtime Nix-mode detection across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- Stable Nix defaults: Covers Stable Nix defaults across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Managed-by-Nix banner: Covers Managed-by-Nix banner across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Read-only config controls: Covers Read-only config controls across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Onboarding skip: Covers Onboarding skip across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (42%)`
- Positive signals: Source and Swift tests cover the exact env/defaults detection paths, including the stable macOS defaults suite.
- Negative signals: Coverage does not include an actual Nix-built gateway/app process proving that the environment/defaults are supplied correctly by Home Manager or NixOS.
- Integration gaps: No launchd/systemd/Home Manager e2e was found that starts OpenClaw in Nix mode and observes downstream guarded behavior.

## Quality Score

- Score: `Alpha (52%)`
- Gitcrawl reports: Exact `OPENCLAW_NIX_MODE` and `openclaw.nixMode` searches returned no focused GitHub hits, which is neutral after freshness checks.
- Discrawl reports: A February `nix-openclaw Gateway start blocked` thread included a systemd unit with `OPENCLAW_NIX_MODE=1`, config path, and state dir, showing real operator use and failure investigation.
- Good qualities: The Node detection is intentionally strict (`OPENCLAW_NIX_MODE === "1"`), and macOS resolves both process env and defaults without relying on shell inheritance.
- Bad qualities: The activation contract is split between env vars and macOS defaults, and current operator reports show that correct activation alone does not make the install path smooth.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (42%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Environment activation, macOS defaults activation, Runtime Nix-mode detection, Stable Nix defaults, Managed-by-Nix banner, Read-only config controls, Onboarding skip.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No local Nix fixture proves that `nix-openclaw` sets the expected env/defaults in every supported service shape.
- The macOS default path needs operator awareness because GUI apps do not inherit shell env.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/nix.md:53` says `OPENCLAW_NIX_MODE=1` is automatic with `nix-openclaw`.
- `/Users/kevinlin/code/openclaw/docs/install/nix.md:58` documents manual `export OPENCLAW_NIX_MODE=1`.
- `/Users/kevinlin/code/openclaw/docs/install/nix.md:61` through `:64` documents `defaults write ai.openclaw.mac openclaw.nixMode -bool true` for macOS GUI activation.

### Source

- `/Users/kevinlin/code/openclaw/src/config/paths.ts:9` through `:16` define Nix mode as `OPENCLAW_NIX_MODE === "1"` and document its intended behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ProcessInfo+OpenClaw.swift:8` through `:23` resolves Nix mode from `OPENCLAW_NIX_MODE`, `UserDefaults.standard`, and the stable `ai.openclaw.mac` suite for app bundles.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ProcessInfo+OpenClaw.swift:27` through `:34` wires that resolver into `ProcessInfo.processInfo.isNixMode`.

### Integration tests

- No real installed Nix activation e2e was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/config/config.nix-integration-u3-u5-u9.test.ts:24` through `:38` verifies false/true behavior for `OPENCLAW_NIX_MODE`.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/NixModeStableSuiteTests.swift:6` through `:24` verifies the stable defaults suite is honored for app bundles.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/NixModeStableSuiteTests.swift:26` through `:39` verifies the stable suite is ignored outside app bundles.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "OPENCLAW_NIX_MODE" --json`

Results:

- Returned `hits: []`.

Query:

`gitcrawl search openclaw/openclaw --query "openclaw.nixMode" --json`

Results:

- Returned `hits: []`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "OPENCLAW_NIX_MODE"`

Results:

- `nix-openclaw Gateway start blocked` on 2026-02-05 included a systemd service with `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_NIX_MODE=1`.
- A maintainer message on 2026-05-08 described policy changes for npm plugins inside declarative installs gated behind env vars.
