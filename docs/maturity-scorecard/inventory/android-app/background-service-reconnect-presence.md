---
title: "Android app - Background Service, Reconnect, and Presence Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Background Service, Reconnect, and Presence Maturity Note

## Summary

Android background operation is implemented around a foreground service, persistent notification, reconnecting Gateway sessions, presence-alive beacons, notification-listener state, and foreground-service microphone type switching. Coverage is Alpha because docs and source cover the intended behavior but no live backgrounding scorecard was found. Quality is the weakest Android component: archive evidence includes a foreground-service crash issue and an active PR to avoid persistent `dataSync` foreground service use.

## Category Scope

- `NodeForegroundService`, persistent notification, background reconnect, node presence beacons, notification listener state, Gateway session reconnect, and reconnect after app backgrounding.
- Out of scope: individual node command handlers except where foreground/background state changes command availability.

## Features

- Background reconnect and presence: Foreground-service presence, reconnect, and node presence behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (62%)`
- Positive signals: Docs explicitly say Android keeps the Gateway connection alive through a foreground service, auto-reconnects after first pairing, and sends `node.presence.alive` when backgrounded while connected. Source implements foreground notification state, reconnect loop, presence beacon payload/skip logic, and reconnect tests.
- Negative signals: No live Android backgrounding scenario was found that proves app background, foreground-service notification, presence beacon handling, Gateway restart, network loss, and app relaunch together.
- Integration gaps: Need a real-device background/reconnect scorecard across Android 14/15 service restrictions, battery saver, network changes, Gateway restart, and Talk Mode microphone service promotion/demotion.

## Quality Score

- Score: `Alpha (55%)`
- Gitcrawl reports: `ForegroundServiceStartNotAllowedException Android` found issue #64903 for Android app crashes on `NodeForegroundService startForeground` with `ForegroundServiceStartNotAllowedException` and PR #80082 `fix(android): avoid dataSync FGS for persistent node`.
- Discrawl reports: `Android foreground service reconnect presence` returned no direct hits. Broader support context under node capability searches notes mobile node background state causes Canvas/camera/screen failures.
- Good qualities: The service uses a low-importance persistent notification, updates title/text from runtime state, adds a Disconnect action, switches service type for Talk Mode, and presence beacon responses require `handled: true` before counting durable last-seen updates.
- Bad qualities: Android foreground-service policy is a live crash risk, persistent node operation touches OS service quotas, and docs do not provide a current operator recipe for battery optimization, service denial, or reconnect triage.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Background reconnect and presence.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Prove background reconnect and presence on current Android OS versions with real devices.
- Add operator guidance for foreground-service denial, battery saver, OEM background restrictions, and notification permission states.
- Clarify which commands intentionally fail while the app is backgrounded and how to recover.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` documents foreground service connection keepalive, auto-reconnect on launch, and presence alive beacons after authenticated node session connect and backgrounding.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` lists authenticated background presence beacons and push notifications in the rebuild checklist.
- `/Users/kevinlin/code/openclaw/docs/nodes/troubleshooting.md` is linked as related Android node troubleshooting.

### Source

- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/NodeForegroundService.kt` starts a foreground service, maintains the persistent notification, exposes Disconnect, and promotes service types for Talk Mode.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/ConnectionManager.kt` builds node connect options, user agent, advertised capabilities, and TLS policy used on reconnect.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/NodePresenceAliveBeacon.kt` builds and decodes `node.presence.alive`, throttles recent successes, and sanitizes failure reasons.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt` owns connect, disconnect, reconnect, pause-after-auth-failure, and current connection closure.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/DeviceNotificationListenerService.kt` tracks notification-listener connection state and emits `notifications.changed` events.

### Integration tests

- No live background/reconnect Android scenario was found.
- `/Users/kevinlin/code/openclaw/src/gateway/android-node.capabilities.live.test.ts` requires the app to stay unlocked and foregrounded for capability execution, which highlights the missing background scenario.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/NodeForegroundServiceTest.kt` covers foreground-service notification/type behavior.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/gateway/GatewaySessionReconnectTest.kt` covers replacing active connections and reconnect pause behavior.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/node/NodePresenceAliveBeaconTest.kt` covers presence beacon payload/response helper behavior.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/node/ConnectionManagerTest.kt` covers connection manager behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "ForegroundServiceStartNotAllowedException Android" --json`

Results:

- Issue #64903 `Android app crashes on NodeForegroundService startForeground with ForegroundServiceStartNotAllowedException`.
- PR #80082 `fix(android): avoid dataSync FGS for persistent node`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android foreground service reconnect presence"`

Results:

- No direct hits.

Additional query context:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android node capabilities gateway commands"` found support guidance that mobile node Canvas/camera/screen commands fail when the app is backgrounded.
