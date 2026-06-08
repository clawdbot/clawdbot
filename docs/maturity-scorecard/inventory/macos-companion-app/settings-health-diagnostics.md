---
title: "macOS companion app - Status and Settings Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Status and Settings Maturity Note

## Summary

The settings and diagnostics surface is broad: General/Connection, Permissions, Voice Wake, Channels, Skills, Cron, Exec Approvals, Sessions, Instances, Config, Debug, About, health polling, channel status cards, rolling diagnostics logs, and debug actions. Coverage is Beta because settings and health flows are broad with supporting smoke/helper proof, but no full operator diagnostic scenario was found. Quality is Beta because the implementation and docs are clear, while archive evidence shows diagnostics and channel health remain common operator pressure points.

## Category Scope

Included in this category:

- Menu-bar status: Menu-bar status, action menu, status icon state, dock menu, dashboard/chat/canvas/talk shortcuts
- Activity state ingestion: Activity state ingestion and status row behavior
- Settings navigation: Settings navigation and tabs
- Health polling: Health polling, channel status, logs, debug actions, config/session/instance visibility
- Channels settings: Channels settings and QR/login/probe status surfaced through the app

## Features

- Menu-bar status: Menu-bar status, action menu, status icon state, dock menu, dashboard/chat/canvas/talk shortcuts
- Activity state ingestion: Activity state ingestion and status row behavior
- Settings navigation: Settings navigation and tabs
- Health polling: Health polling, channel status, logs, debug actions, config/session/instance visibility
- Channels settings: Channels settings and QR/login/probe status surfaced through the app

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Source covers settings groups, lazy-cached tabs, permission monitoring, config/state path snapshot, health polling, channel status, debug menu, rolling file logging, and channel settings stores. Smoke tests build major settings tabs, channel settings, instances, sessions, config, debug, and health state helpers.
- Negative signals: No full operator scenario proves diagnosing a broken channel, revealing logs, running health check, updating config, and recovering a Gateway/channel from the macOS app.
- Integration gaps: Need a packaged-app diagnostic flow for health degraded, channel login/probe, log capture, config edit, and remote/local mode switching.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Results include diagnostics/log health issues such as #84787 status spending 40-50s in summary/model-runtime resolution, #84012 status hangs before Gateway connection, #53684 gateway failure recovery/notification request, and #87402 managed listener conflict. Channel-settings query results include app settings PRs and channel-related reports.
- Discrawl reports: Maintainer reports highlight quality/diagnostics work, observability smokes, log timestamp/follow fixes, macOS plist handling, and release testing checklists that include `openclaw status`, `openclaw doctor`, logs, channel/provider, and exact version.
- Good qualities: Settings are grouped by operator task, health store caches last success/error to avoid flicker, debug logging is explicitly sensitive/off by default, and settings can reopen onboarding for permission recovery.
- Bad qualities: The operator still has to reason across app health, CLI status/doctor, channel state, Gateway logs, remote tunnels, and native permissions. Archive evidence shows status/diagnostics can hang or under-explain recovery.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Menu-bar status, Activity state ingestion, Settings navigation, Health polling, Channels settings.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need a "what to inspect first" native diagnostic route for Gateway offline, channel unlinked, node disconnected, and remote tunnel degraded.
- Need live proof that channel QR/login/probe actions recover common channel states.
- Need easier safe sharing/review flow for diagnostics logs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/health.md` documents menu/settings health state, probe behavior, cached snapshot, and related CLI checks.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/logging.md` documents rolling diagnostics file logging, unified logging privacy, and sensitive-log handling.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` documents debug gateway connectivity CLI and related docs.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/remote.md` includes troubleshooting for WebChat stuck, node/capability offline, and Voice Wake.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/SettingsRootView.swift` defines settings tab groups and routes detail views for General, Connection, Permissions, Voice Wake, Channels, Skills, Cron, Exec Approvals, Sessions, Instances, Config, Debug, and About.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/HealthStore.swift` polls health, caches snapshots/errors, and derives summary/degraded states.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ChannelsSettings.swift` and `ChannelsStore*.swift` surface channel config/status/lifecycle.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/DiagnosticsFileLog.swift` implements rolling diagnostics logs.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/DebugActions.swift` implements debug health/log/config actions.

### Integration tests

- No full native operator diagnostic scenario was found.
- `/Users/kevinlin/code/openclaw/qa/scenarios/config/config-apply-restart-wakeup.md` and related QA scenarios cover Gateway/config behavior, not the native settings path.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/SettingsViewSmokeTests.swift` renders many settings views, including permissions, general, config, debug, sessions, instances, and voice wake.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/ChannelsSettingsSmokeTests.swift` renders channel settings.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/HealthStoreStateTests.swift`, `HealthDecodeTests.swift`, and `LogLocatorTests.swift` cover health/log helpers.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/ConfigStoreTests.swift`, `OpenClawConfigFileTests.swift`, and `ConfigSchemaSupportTests.swift` cover config backing behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS diagnostics log health" --json`

Results:

- Issue #84787 `openclaw status spends 40-50s in session summary/model-runtime resolution`.
- Issue #84012 `openclaw status CLI command hangs before connecting to gateway`.
- Issue #53684 `Gateway failure recovery and notification mechanism`.
- Issue #87402 `Gateway restart treats managed listener as port conflict`.

Query:

`gitcrawl search openclaw/openclaw --query "macOS app channel settings" --json`

Results:

- PR #59214 `Add user chat bubble color selector for macOS application`.
- Issue #82709 `Doctor/config warnings for risky heartbeat and timeout combinations`.
- Issue #70253 includes install method `mac app` and channel/config behavior.
- PR #58333 references a packaged macOS app build for config UI.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS diagnostics"`

Results:

- 2026-05-26 maintainer report lists quality and diagnostics work, observability smokes, log timestamp/follow fixes, macOS plist handling, and Windows-safe scripts.
- 2026-05-22 maintainer report lists diagnostics work and macOS gateway ancestry detection.
- 2026-05-16 beta test focus asks users to include `openclaw status --all`, `openclaw doctor`, channel/provider, and what changed after update.
