---
title: "iOS app - Location, Motion, Calendar, Contacts, and Reminders Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Location, Motion, Calendar, Contacts, and Reminders Maturity Note

## Summary

The iOS app exposes meaningful personal-context commands: current location, significant-location updates, motion/pedometer, contacts search/add, calendar events/add, and reminders list/add. Coverage is low Experimental because these features have source and unit proof plus a manual node script, but no current device QA scorecard for Apple permission states, background location, or automation effects. Quality is mid Experimental because source paths are direct and permission-scoped, while archive evidence shows background location, APNs wake, Shortcuts, HealthKit, and Apple platform limits remain active points of operator confusion.

## Category Scope

- Location modes, current location, significant-location events, motion activity and pedometer, contacts, calendar, reminders, permission request bridges, and personal-context command payloads.
- Out of scope: APNs delivery itself, HealthKit future work, and Android foreground-service location.

## Features

- Location modes: Location modes, current location, significant-location events, motion activity and pedometer, contacts, calendar, reminders, permission request bridges, and personal-context command payloads

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (37%)`
- Positive signals: Docs describe location modes and movement-automation intent. `scripts/dev/ios-node-e2e.ts` can invoke contacts, calendar, reminders, motion, and photos commands against a connected node. Swift tests cover location capability advertisement and permission helper behavior.
- Negative signals: No automated device proof was found for Always location, background significant-location delivery, permission-denied recovery, calendar/reminder mutations, contact writes, motion permission, or geofence-like automations.
- Integration gaps: Need a real-device personal-context scorecard that exercises each permission state and verifies Gateway events after foreground and background transitions.

## Quality Score

- Score: `Experimental (45%)`
- Gitcrawl reports: `iOS background location` found issue #86217 questioning whether iOS background location claims should include `UIBackgroundModes=location`, PR #63123 for background alive support, issue #68581 referencing iOS-style location modes, and issue #46664 for offline command queue.
- Discrawl reports: `iOS background location` found a support thread about BetterClaw/background iOS companion testing, a March iOS/watchOS thread where APNs wake failed with `path=no-registration` for background `nodes location get`, and operator commentary that foreground location works while background wake remains the hard part.
- Good qualities: Location mode gates distinguish `off`, foreground, and `always`; background `location.get` requires Always authorization; significant-location updates emit `location.update`; EventKit and Contacts code requests least-scope access where possible.
- Bad qualities: Docs and source disagree on whether background location has all required platform modes, background location depends on push/wake behavior, and several personal-context features need clearer product expectations under Apple restrictions.
- Excluded from quality: Unit tests and the manual live script were not used as Quality inputs.

## Completeness Score

- Score: `Experimental (37%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Location modes.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Decide and document whether iOS background location requires adding `UIBackgroundModes=location` for the current support promise.
- Add real-device QA for significant-location wake, `location.update`, and `nodes location get` while backgrounded.
- Clarify unsupported adjacent expectations such as reading notifications, HealthKit, and continuous GPS.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents location, background alive behavior, location automation, and common background limits.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` documents location automation testing, Always permission, significant movement, and expected Gateway side effects.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Location/LocationService.swift` implements current location, Always authorization, update streams, and significant-location monitoring.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Location/SignificantLocationMonitor.swift` sends `location.update` events to the Gateway.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Contacts/ContactsService.swift`, `CalendarService.swift`, `RemindersService.swift`, and `MotionService.swift` implement the personal-context command families.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Settings/PrivacyAccessSectionView.swift` exposes permission actions for contacts, calendar, and reminders.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/dev/ios-node-e2e.ts` includes contacts, calendar, reminders, motion, and photos command checks against a connected iOS node.
- No automated real-device background location or personal-data permission e2e artifact was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/GatewayConnectionControllerTests.swift` checks location capability and command advertisement.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/PermissionRequestBridgeTests.swift` checks permission continuation behavior.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/SettingsNetworkingHelpersTests.swift` covers diagnostics and related settings helper behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS background location" --json`

Results:

- Issue #86217 `Question: should iOS background location claims include UIBackgroundModes=location?`.
- PR #63123 `feat(ios): add background alive beacon support`.
- Issue #46664 `[Feature]: Offline Command Queue for iOS/Android Node App`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS background location"`

Results:

- May 1 report notes BetterClaw/background iOS companion testing focus around onboarding, reconnects, battery, Shortcuts, and geofences.
- March 1 iOS/watchOS thread reports foreground `nodes location get` works, but background wake fails with APNs `path=no-registration`.
- February support note says location is supported with iOS While Using versus Always constraints and that HealthKit is not integrated in the current iOS app surface.
