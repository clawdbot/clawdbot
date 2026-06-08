---
title: "Android app - Settings Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Settings Maturity Note

## Summary

Android settings and diagnostics cover a large operator surface: profile, Gateway settings, camera/location/mic/photos/motion/SMS/call-log/notification permissions, notification forwarding policy, nodes/devices view, provider/model state, and copyable Gateway diagnostics. Coverage is Alpha because the source and unit coverage are broad but no integrated operator recovery scenario was found. Quality is Alpha but stronger than the background service because the app has clear safety controls, policy filters, and copyable diagnostic text.

## Category Scope

Included in this category:

- Settings sheet: Settings sheet and settings detail screens, permission request UX, notification forwarding controls, Nodes & Devices status, provider/model diagnostics, secure preferences, and copyable Gateway diagnostic report

## Features

- Settings sheet: Settings sheet and settings detail screens, permission request UX, notification forwarding controls, Nodes & Devices status, provider/model diagnostics, secure preferences, and copyable Gateway diagnostic report

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: Docs describe permission prerequisites and notification forwarding controls. Source implements permission launchers, rationale/settings dialogs, notification allowlist/blocklist/quiet-hours/rate-limit/session controls, node/device status panels, and diagnostic report copy. Unit tests cover several settings and policy helpers.
- Negative signals: No integrated Android operator recovery flow was found for "Gateway offline", "pairing/auth failure", "missing permission", "notification listener disabled", and "node capability unavailable" from one UI path.
- Integration gaps: Need a settings/diagnostics scenario that starts from common failures, copies diagnostics, changes permissions/policy, reconnects Gateway, and verifies the corresponding command/capability state changes.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: `Android light mode theme toggle` found issue #87688 requesting a light mode/theme toggle. More capability-specific searches found future Health Connect and Google Home requests, which imply settings will need more capability management as Android expands.
- Discrawl reports: `Android settings permissions diagnostics notification forwarding` returned no direct hits.
- Good qualities: Permission prompts are centralized and can show rationale/settings dialogs; notification forwarding has allowlist/blocklist, quiet hours, rate limiting, session key, safer self-package handling, and app-picker UI; Gateway diagnostics text tells users what commands and facts to provide.
- Bad qualities: Operator recovery is spread across several screens, theme/accessibility customization is incomplete, and there is no recorded live flow tying settings changes to Gateway/node capability changes.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Settings sheet.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a compact Android diagnostics runbook for connection, permissions, notification forwarding, and node command availability.
- Add live proof that settings toggles update advertised capabilities without stale Gateway state.
- Decide whether theme/accessibility options are part of the Android app support promise before promotion.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` documents Android permissions, notification forwarding controls, connection diagnostics, and related troubleshooting links.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` documents rebuild items for settings restyle, permission requests in onboarding/settings, push notifications, security hardening, and Play restricted permissions.

### Source

- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/SettingsSheet.kt` implements broad settings and permission controls, notification forwarding UI, assistant role state, camera/location/mic/photos/motion/SMS/call-log availability, and installed-app picker state.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/NodesDevicesSettingsScreen.kt` shows live nodes, paired devices, pending device requests, status badges, and refresh/error states.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/PermissionRequester.kt` centralizes missing-permission requests, rationale dialogs, timeouts, and settings redirects.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/NotificationForwardingPolicy.kt` implements package allow/block filtering, quiet-hours evaluation, and burst limiting.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/GatewayDiagnostics.kt` builds a copyable diagnostic prompt with screen, app version, device, Android SDK, gateway address, and status/error.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/SecurePrefs.kt` persists app, Gateway, notification, and device settings.

### Integration tests

- No integrated Android settings/operator recovery scenario was found.
- `/Users/kevinlin/code/openclaw/src/gateway/android-node.capabilities.live.test.ts` indirectly depends on settings-controlled command availability and policy allowlists.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/PermissionRequesterTest.kt`, `NotificationForwardingPolicyTest.kt`, `SecurePrefsTest.kt`, and `SecurePrefsNotificationForwardingTest.kt` cover permission and settings helpers.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/ui/SettingsSheetNotificationAppsTest.kt`, `ProviderModelStatusTest.kt`, and `GatewayConfigResolverTest.kt` cover settings UI helpers.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Android light mode theme toggle" --json`

Results:

- Issue #87688 `Android app: Add light mode / theme toggle`.
- Issue #28300 `Theme Customization System - Preset Themes + Custom Theme Studio` as adjacent theme work.

Query:

`gitcrawl search openclaw/openclaw --query "Android app settings permissions diagnostics" --json`

Results:

- No direct hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android settings permissions diagnostics notification forwarding"`

Results:

- No direct hits.
