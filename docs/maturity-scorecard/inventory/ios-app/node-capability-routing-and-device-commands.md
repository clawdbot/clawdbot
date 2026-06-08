---
title: "iOS app - Device Commands Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Device Commands Maturity Note

## Summary

The iOS node has a broad command surface and a centralized invoke router for device, system, chat, watch, photos, contacts, calendar, reminders, motion, location, camera, screen, Canvas, and Talk commands. Coverage remains Experimental because the live proof is a maintainer-run script against an already connected iOS node, not a repeatable release smoke that provisions, pairs, foregrounds, and exercises the full command matrix. Quality is near the top of Experimental because command routing is explicit and foreground/background errors are productized, but archive evidence still shows unresolved requests around offline queueing and mobile capability availability.

## Category Scope

Included in this category:

- Location modes: Location modes, current location, significant-location events, motion activity and pedometer, contacts, calendar, reminders, permission request bridges, and personal-context command payloads
- Device command handling: iOS device command handling, foreground/background gating, command specifications, and capability visibility.

## Features

- Location modes: Location modes, current location, significant-location events, motion activity and pedometer, contacts, calendar, reminders, permission request bridges, and personal-context command payloads
- Device command handling: iOS device command handling, foreground/background gating, command specifications, and capability visibility.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (45%)`
- Positive signals: `scripts/dev/ios-node-e2e.ts` can connect as an operator, select a connected iOS node, and invoke representative commands including `device.info`, `device.status`, `system.notify`, contacts, calendar, reminders, motion, photos, camera, and screen recording. Swift tests cover capability advertisement and routing decisions.
- Negative signals: The live script requires an already reachable Gateway token and a connected/pairable iOS node, and it does not appear to be wired into recurring CI or a release scoreboard. No full-device command matrix run artifact was found for the current row.
- Integration gaps: Need a TestFlight or real-device scorecard that starts from install/pair, verifies advertised commands, runs safe commands, runs foreground-only commands while foregrounded, verifies expected failures while backgrounded, and records permission states.

## Quality Score

- Score: `Experimental (48%)`
- Gitcrawl reports: `iOS node capabilities` found PR #63123 for background alive support and issue #46664 requesting an offline command queue for iOS/Android node apps. `iOS node commands foreground background` and `NODE_BACKGROUND_UNAVAILABLE` returned no direct hits.
- Discrawl reports: `iOS node commands foreground background unavailable` found a support explanation that Canvas, camera, and screen commands are foreground-only on iOS/Android and usually fail with `NODE_BACKGROUND_UNAVAILABLE` when the app is backgrounded.
- Good qualities: Command routing is centralized, unknown commands return explicit invalid-request errors, foreground-only commands share a common background gate, dangerous host shell commands are absent from iOS command advertisement, and services have scoped permission errors.
- Bad qualities: The command inventory is wide for an internal preview, and operators still need stronger in-app and docs guidance for which commands are safe in background, which require foreground, and which require Apple permissions.
- Excluded from quality: Unit and live-script coverage were not used to raise or lower Quality.

## Completeness Score

- Score: `Experimental (45%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Location modes, Device command handling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a published iOS command availability table for foreground, background, local build, and TestFlight build modes.
- Promote the manual node e2e script into a recurring, artifact-producing real-device smoke.
- Clarify offline or queued command behavior instead of relying on immediate connected-node execution.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` lists iOS node capabilities and explicitly frames foreground/background limits.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` lists concrete iPhone node commands and states that foreground use is the reliable mode.
- `/Users/kevinlin/code/openclaw/docs/gateway/protocol.md` documents `node.invoke`, `push.test`, and iOS node protocol examples.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Capabilities/NodeCapabilityRouter.swift` maps command strings to handlers.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel.swift` handles `node.invoke`, enforces `NODE_BACKGROUND_UNAVAILABLE`, and registers command handlers.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Device/DeviceStatusService.swift`, `ContactsService.swift`, `CalendarService.swift`, `RemindersService.swift`, `MotionService.swift`, and `PhotoLibraryService.swift` implement device command payloads.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Gateway/GatewayConnectionController.swift` builds advertised caps and commands from current settings.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/dev/ios-node-e2e.ts` is a live maintainer script for invoking an already connected iOS node.
- No automated iOS command matrix e2e or TestFlight release smoke artifact was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/GatewayConnectionControllerTests.swift` checks capability advertisement, location command inclusion, and absence of dangerous system exec commands.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/NodeAppModelInvokeTests.swift` exercises invoke helpers, session keys, and notification prompt behavior.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/AppCoverageTests.swift` checks background state transitions.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS node capabilities" --json`

Results:

- PR #63123 `feat(ios): add background alive beacon support`.
- Issue #46664 `[Feature]: Offline Command Queue for iOS/Android Node App`.

Additional query context:

- `gitcrawl search openclaw/openclaw --query "iOS node commands foreground background" --json` returned no hits.
- `gitcrawl search openclaw/openclaw --query "NODE_BACKGROUND_UNAVAILABLE" --json` returned no hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS node commands foreground background unavailable"`

Results:

- Discord support note explains that `canvas.*`, `camera.*`, and `screen.*` are foreground-only on iOS/Android nodes and usually fail with `NODE_BACKGROUND_UNAVAILABLE` when backgrounded.
