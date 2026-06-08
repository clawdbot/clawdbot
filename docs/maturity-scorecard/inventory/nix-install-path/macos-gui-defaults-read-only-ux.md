---
title: "Nix install path - macOS Nix-mode UX Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - macOS Nix-mode UX Maturity Note

## Summary

The macOS app has concrete Nix-mode behavior: stable-suite defaults, onboarding skip, config-save disablement, and a visible managed-by-Nix banner. This is a strong source-quality signal for the GUI side of the Nix install path, but the proof stops short of an installed `.app` launched from a Nix/Home Manager profile.

## Category Scope

This category covers the macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.

## Features

- Stable Nix defaults: Covers Stable Nix defaults across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Managed-by-Nix banner: Covers Managed-by-Nix banner across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Read-only config controls: Covers Read-only config controls across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Onboarding skip: Covers Onboarding skip across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (45%)`
- Positive signals: Swift tests cover stable-suite Nix-mode detection, and source shows settings/onboarding/config writes responding to Nix mode.
- Negative signals: No installed macOS app e2e proves defaults written by a Nix-managed launchd/Home Manager setup are read by the shipped app bundle.
- Integration gaps: No screenshot/UI automation proof was found for the Nix banner or disabled save control under an actual Nix install.

## Quality Score

- Score: `Alpha (50%)`
- Gitcrawl reports: `Managed by Nix` and `Nix mode banner` returned no focused GitHub hits, which is neutral after freshness checks.
- Discrawl reports: A March 2026 Discord answer notes docs can use "banner" to mean a read-only mode UI hint for Nix, showing operator-facing terminology exists but is not heavily issue-backed.
- Good qualities: The app handles GUI env inheritance explicitly, uses a stable defaults suite to survive bundle-id churn, disables config saves, and surfaces config/state paths in the banner.
- Bad qualities: This behavior is macOS-specific and still depends on external packaging correctly writing defaults into the expected suite.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (45%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Stable Nix defaults, Managed-by-Nix banner, Read-only config controls, Onboarding skip.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No installed app proof from a Nix-built `.app` bundle.
- The docs say "UI surfaces a read-only Nix mode banner," but local evidence is source-level rather than screenshot-backed.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/nix.md:61` through `:64` documents the macOS defaults command.
- `/Users/kevinlin/code/openclaw/docs/install/nix.md:73` says the UI surfaces a read-only Nix mode banner.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ProcessInfo+OpenClaw.swift:8` through `:23` resolves Nix mode from env, standard defaults, and stable suite.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/Onboarding.swift:31` through `:34` skips onboarding in Nix mode.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ConfigSettings.swift:167` through `:168` shows read-only text in Nix mode.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ConfigSettings.swift:196` through `:197` disables the Save button in Nix mode.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/OpenClawConfigFile.swift:64` prevents config writes in production Nix mode.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/SettingsRootView.swift:104` through `:151` displays a `Managed by Nix` banner with config and state paths.

### Integration tests

- No installed app, screenshot, or Home Manager launchd integration proof was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/NixModeStableSuiteTests.swift:6` through `:39` verifies stable-suite behavior for app bundles and non-app contexts.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/ConfigStoreTests.swift:73` through `:135` covers config store behavior with explicit config paths.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Managed by Nix" --json`

Results:

- Returned `hits: []`.

Query:

`gitcrawl search openclaw/openclaw --query "Nix mode banner" --json`

Results:

- Returned `hits: []`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Managed by Nix"`

Results:

- Returned one broad golden-path-deployments message about documents being managed by Nix; no focused macOS app UX issue.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Nix mode banner"`

Results:

- Returned a 2026-03-03 support answer clarifying that docs may use "banner" to mean a UI hint such as read-only mode for Nix.
