---
title: "macOS companion app - Local Setup Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Local Setup Maturity Note

## Summary

The first-run path is implemented as a native onboarding window with local/remote page selection, permission setup, CLI installation, Gateway wizard startup, workspace selection, and onboarding chat isolation. Coverage is Beta because the native flow is implemented with supporting smoke and packaging checks, but the audit did not find a repeatable clean-machine macOS app install scenario that proves install, permissions, Gateway startup, one chat turn, and workspace setup together. Quality is Beta: the UX is broad and well documented, while archive evidence still shows onboarding/setup drift and maintainers asking for clean-install beta smoke.

## Category Scope

Included in this category:

- Local mode Gateway attach/start/stop: Local mode Gateway attach/start/stop behavior, status, and operator-visible verification.
- LaunchAgent install/update/restart/uninstall: LaunchAgent install/update/restart/uninstall through app-managed CLI calls
- Existing-listener detection: Existing-listener detection, port guarding, and launchd log path
- Native first-run onboarding flow: Native first-run onboarding flow and completion marker
- CLI discovery: CLI discovery and "Install CLI" prompt/install path
- Local workspace selection: Local workspace selection and Gateway wizard startup
- Onboarding WebChat session separation: Onboarding WebChat session separation behavior, status, and operator-visible verification.

## Features

- Local mode Gateway attach/start/stop: Local mode Gateway attach/start/stop behavior, status, and operator-visible verification.
- LaunchAgent install/update/restart/uninstall: LaunchAgent install/update/restart/uninstall through app-managed CLI calls
- Existing-listener detection: Existing-listener detection, port guarding, and launchd log path
- Native first-run onboarding flow: Native first-run onboarding flow and completion marker
- CLI discovery: CLI discovery and "Install CLI" prompt/install path
- Local workspace selection: Local workspace selection and Gateway wizard startup
- Onboarding WebChat session separation: Onboarding WebChat session separation behavior, status, and operator-visible verification.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Source includes native onboarding page ordering, remote/local branching, Gateway wizard startup, onboarding chat session isolation, CLI detection, and CLI installation. Swift tests exercise onboarding pages and wizard views. Packaging tests cover macOS bundle/install-script behavior.
- Negative signals: The available tests are mostly unit, smoke, and packaging-script checks. They do not prove the full candidate scenario from a fresh installed app through permissions, local Gateway attach, `system.run`, screen snapshot, and message delivery.
- Integration gaps: Missing a durable macOS clean-install release smoke that installs the app, grants TCC prompts, installs CLI from the app, starts/attaches Gateway, writes workspace config, and sends an onboarding chat turn.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Query results include PR #47263 to improve macOS onboarding UX and gateway setup, issue #65345 for docs/code alignment questions across config/APIs/onboarding, and PR #87255 for a config path bug involving onboarding writes.
- Discrawl reports: Release discussion asks for human clean-install smoke on macOS, and release notes call out install/update hardening rather than a settled app-install proof.
- Good qualities: The onboarding flow is mode-aware, avoids interactive setup in Nix mode, isolates onboarding chat, restarts lost wizard sessions once, and gives a post-onboarding CLI prompt only when local mode needs it.
- Bad qualities: Source and docs differ on install host names (`openclaw.bot/install-cli.sh` in source versus public install docs under `openclaw.ai`), and archive evidence shows setup/onboarding alignment remains active.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Local mode Gateway attach/start/stop, LaunchAgent install/update/restart/uninstall, Existing-listener detection, Native first-run onboarding flow, CLI discovery, Local workspace selection, Onboarding WebChat session separation.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need one documented clean-app scenario that runs the full first-run flow against a real signed app bundle.
- Need stronger docs/source alignment around app-driven CLI installation URL and expected package-manager fallback.
- Need an operator-facing "what failed" view for CLI install, wizard, workspace path, and Gateway attach failures in one place.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` documents the app as the menu-bar companion, local/remote modes, CLI install, permissions checklist, and typical onboarding flow.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/bundled-gateway.md` states that the macOS app expects an external CLI install and that the Install CLI button uses npm, pnpm, then bun.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/dev-setup.md` documents developer build and CLI setup.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/Onboarding.swift` defines onboarding page ordering for local, remote, and unconfigured modes, marks completion, and creates an `OpenClawChatViewModel` with session key `onboarding`.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/OnboardingWizard.swift` starts the Gateway wizard in local mode, submits wizard steps, and retries once when a wizard session is lost.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/CLIInstaller.swift` resolves installed CLI paths and runs the JSON install script with a version and prefix.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/CLIInstallPrompter.swift` prompts post-onboarding local-mode users when the CLI is missing.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/package-mac-app.test.ts` checks macOS package-script behavior, dependency install lockfile safety, app process targeting, and inclusion in the macOS CI lane.
- `/Users/kevinlin/code/openclaw/test/scripts/codesign-mac-app.test.ts` and `/Users/kevinlin/code/openclaw/test/scripts/notarize-mac-artifact.test.ts` validate release-script hygiene and fail-closed checks.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/OnboardingCoverageTests.swift` exercises onboarding pages.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/OnboardingViewSmokeTests.swift`, `OnboardingWizardStepViewTests.swift`, and `OnboardingRemoteAuthPromptTests.swift` cover onboarding rendering and remote auth prompt behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/CLIInstallerTests.swift` covers CLI install helper behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS onboarding CLI install" --json`

Results:

- PR #47263 `Improve macOS onboarding UX and gateway setup`.
- Issue #65345 `Docs/code alignment questions across config, APIs, and onboarding`.
- PR #87255 `fix(config): skip .openclaw append when OPENCLAW_HOME already names a state dir`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS Install CLI"`

Results:

- 2026-05-23 maintainer message requests clean macOS/Linux/Windows smoke covering fresh install, upgrade, Gateway start, one chat turn, plugin load, and logs.
- 2026-05-27 release note says install/update paths were hardened, including macOS runner bootstraps.
