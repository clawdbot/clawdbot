---
title: "Android app - Device Runtime Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Device Runtime Maturity Note

## Summary

Android node capabilities are broad: device status/info/permissions/health, notifications, system notify, contacts, calendar, location, motion, camera, Canvas/A2UI, Talk PTT, and flavor-gated SMS/call-log/photos. Coverage reaches Beta because the Gateway live capability test executes the advertised non-interactive command surface against a paired Android node. Quality remains Alpha because archive evidence includes zero-command advertisement failures, notification forwarding cross-session risk, and multiple open requests for additional native Android capability families.

## Category Scope

Included in this category:

- Background reconnect and presence: Foreground-service presence, reconnect, and node presence behavior.
- Device command availability: Android device command availability and capability advertisement.

## Features

- Background reconnect and presence: Foreground-service presence, reconnect, and node presence behavior.
- Device command availability: Android device command availability and capability advertisement.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Docs enumerate Android command families and flavor-dependent availability. Source has a central registry for advertised capabilities and commands, dispatcher gates for foreground and permission-sensitive commands, and handlers across the major device surfaces. The live capability test reads `node.describe`, applies the effective Gateway allowlist, invokes advertised non-interactive commands, and fails on unmapped command profiles.
- Negative signals: The live suite is preconditioned and excludes interactive screen-recording consent. It validates command contracts but does not prove every user-facing permission grant or long-lived device-state workflow.
- Integration gaps: Need a full Android node command scorecard that records command availability across Play and third-party builds, denied/granted permissions, foreground/background state, and Gateway allowlist/denylist policy.

## Quality Score

- Score: `Alpha (63%)`
- Gitcrawl reports: `notifications.list Android node` found issue #48516 for notification forwarding causing cross-session replies and issue #87058 for Android node connecting but advertising zero commands. `Android Health Connect read-only node commands` found #78611, and `Google Home API bridge Android app native smart-home` found #78476 as future capability requests.
- Discrawl reports: Search found a GitHub mirror review note that the live Android suite now filters declared commands by effective policy allowlist, a review note asking to add `callLog.search` to live capability profiles, and support guidance that Canvas/camera/screen commands fail when a mobile node is backgrounded or does not advertise the capability.
- Good qualities: Capability advertisement is data-driven, sensitive surfaces are gated by build flavor and runtime availability, command dispatch returns structured errors, and Gateway policy is applied before live command execution.
- Bad qualities: Capability shape is large and permission-dependent; notification events can affect chat/session routing; Play flavor removes several high-value device commands; and future native Android capability asks are already accumulating.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Background reconnect and presence, Device command availability.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Record command availability matrices for Play versus third-party flavor.
- Add release-smoke evidence for notification forwarding session routing and policy filters.
- Keep live capability profiles in lockstep with every newly advertised Android command.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` lists command families: device status/info/permissions/health, notifications, photos, contacts, calendar, call log, SMS, motion, camera, Canvas, and Talk.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` documents Google Play restricted permissions and the Play versus third-party flavor split.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-runtime.md` documents paired node invocation from Gateway-loaded plugins and CLI commands.

### Source

- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt` wires handlers, capability flags, node/operator sessions, sensitive feature config, and command dispatch.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/InvokeCommandRegistry.kt` defines advertised capabilities and commands plus availability gates.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/InvokeDispatcher.kt` routes commands and enforces foreground, debug, permission, flavor, and availability errors.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/DeviceHandler.kt`, `NotificationsHandler.kt`, `ContactsHandler.kt`, `CalendarHandler.kt`, `LocationHandler.kt`, `MotionHandler.kt`, `SystemHandler.kt`, `SmsHandler.kt`, and `CallLogHandler.kt` implement the command families.
- `/Users/kevinlin/code/openclaw/src/gateway/android-node.capabilities.live.test.ts` is the Gateway-side live capability harness.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/android-node.capabilities.live.test.ts` connects to a Gateway, selects a paired Android node, reads `node.describe`, resolves allowlist policy, invokes every mapped advertised non-interactive command, and verifies payload contracts or expected deterministic errors.
- The suite explicitly skips interactive screen-recording consent.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/node/InvokeCommandRegistryTest.kt`, `InvokeDispatcherTest.kt`, `DeviceHandlerTest.kt`, `NotificationsHandlerTest.kt`, `DeviceNotificationListenerServiceTest.kt`, `ContactsHandlerTest.kt`, `CalendarHandlerTest.kt`, `LocationHandlerTest.kt`, `MotionHandlerTest.kt`, and `SystemHandlerTest.kt` cover core command behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/android-node.capabilities.policy-config.test.ts` and `android-node.capabilities.policy-source.test.ts` cover live-suite policy config behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "notifications.list Android node" --json`

Results:

- Issue #48516 `Android node notification forwarding causes cross-session replies (WhatsApp duplicate sends to wrong group)`.
- Issue #87058 `Android node connects but advertises zero commands ...`.

Query:

`gitcrawl search openclaw/openclaw --query "Android Health Connect read-only node commands" --json`

Results:

- Issue #78611 `[Feature]: Android Health Connect read-only node commands`.

Query:

`gitcrawl search openclaw/openclaw --query "Google Home API bridge Android app native smart-home" --json`

Results:

- Issue #78476 `Feature: Google Home API bridge in Android app for native smart-home control`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android node capabilities gateway commands"`

Results:

- 2026-03-19 GitHub mirror review note says the live suite now treats policy allowlist as part of runnable preconditions.
- 2026-03-13 GitHub mirror review note asks to add a `callLog.search` profile to Android live capability checks.
- 2026-03-13 support thread explains Canvas/camera/screen capability failures when no paired node is connected, the mobile app is backgrounded, or capabilities are not advertised.
