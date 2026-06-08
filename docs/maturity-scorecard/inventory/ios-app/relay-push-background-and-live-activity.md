---
title: "iOS app - Notifications and Background Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Notifications and Background Maturity Note

## Summary

The iOS app has one of the most explicitly designed mobile-only flows in OpenClaw: APNs registration, local/direct APNs for manual builds, relay-backed push registration for official/TestFlight builds, App Attest plus StoreKit proof, gateway identity delegation, background alive beacons, significant-location wake handling, and Live Activity connection status. Coverage is Experimental because relay and Gateway tests exist, but there is no current end-to-end TestFlight push registration and background wake scorecard. Quality is Experimental because the trust model is carefully documented, while archive evidence shows APNs credentials, background wake registration, and iOS network policy remain active support risks.

## Category Scope

Included in this category:

- APNs registration and relay delivery: Direct and relay-backed APNs registration, push relay trust, stored relay handles, background alive windows, and Live Activity updates.

## Features

- APNs registration and relay delivery: Direct and relay-backed APNs registration, push relay trust, stored relay handles, background alive windows, and Live Activity updates.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (44%)`
- Positive signals: Docs give the official/TestFlight relay flow; TypeScript tests cover APNs relay signing and config; Swift tests cover background alive payload behavior; app source registers APNs after pairing and uses gateway identity for relay mode.
- Negative signals: No current live TestFlight proof was found that installs an official build, pairs to a Gateway with matching relay URL, registers relay-backed APNs, sends `push.test`, wakes the app in background, and records `node.presence.alive`.
- Integration gaps: Need a TestFlight relay scorecard with relay registration, push.test, reconnect wake, silent push, significant-location wake, and Live Activity state transitions.

## Quality Score

- Score: `Experimental (46%)`
- Gitcrawl reports: `iOS APNs relay push` found PR #81402 mentioning APNs registrations in runtime state. `iOS background alive` found PR #63123 for background alive beacon support. `APNs` also found issue #61041 and issue #67031 related to push/media limits and PR #81402.
- Discrawl reports: `iOS APNs relay background alive push` returned no hits. `iOS background location` found a March iOS/watchOS support thread where Gateway APNs wake attempted `node wake` but failed with `path=no-registration`, and asked how self-hosted users should configure APNs credentials.
- Good qualities: Relay registration requires official distribution, production APNs, App Attest, StoreKit app transaction proof, and delegation to a paired gateway identity. The Gateway relay sender signs relay sends and rejects insecure/malformed relay URLs.
- Bad qualities: Push support has multiple operational modes and credential surfaces; local builds still need direct APNs credentials, official builds need matching relay URLs, and background wake success is hard to distinguish without a dedicated scorecard.
- Excluded from quality: APNs relay tests and background beacon unit tests were not used as Quality inputs.

## Completeness Score

- Score: `Experimental (44%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for APNs registration and relay delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a current TestFlight push scorecard for relay registration, gateway storage, `push.test`, background wake, and alive beacon handling.
- Document self-hosted direct APNs setup versus official relay setup as separate operator decision trees.
- Add operator diagnostics for `path=no-registration`, stale relay handles, mismatched relay base URLs, and production/sandbox topic mismatches.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents relay-backed push, authentication/trust flow, direct APNs for local builds, background alive beacons, and operator steps.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` documents APNs expectations for local/manual and official builds.
- `/Users/kevinlin/code/openclaw/docs/gateway/configuration.md` documents `gateway.push.apns.relay.baseUrl` and the relay-backed official build flow.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Push/PushRegistrationManager.swift` builds direct and relay Gateway registration payloads.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Push/PushRelayClient.swift` registers with relay using App Attest and StoreKit app transaction proof.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Push/BackgroundAliveBeacon.swift` wraps `node.presence.alive` payloads.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel.swift` registers APNs after operator connect, handles background wakes, and coordinates reconnect suppression.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/LiveActivity/LiveActivityManager.swift` tracks connection and attention states.
- `/Users/kevinlin/code/openclaw/src/infra/push-apns.ts` and `push-apns.relay.ts` implement Gateway-side APNs registration and relay sending.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/infra/push-apns-http2.live.test.ts` exists for direct APNs HTTP/2 live behavior, but it is not an iOS app TestFlight relay proof.
- No end-to-end iOS TestFlight relay push or background wake artifact was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/BackgroundAliveBeaconTests.swift` covers alive payload wrapping and old-gateway ack handling.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/ExecApprovalNotificationBridgeTests.swift` covers adjacent push notification bridge behavior.
- `/Users/kevinlin/code/openclaw/src/infra/push-apns.relay.test.ts`, `push-apns.auth.test.ts`, `push-apns.store.test.ts`, and `push-apns.test.ts` cover Gateway APNs relay, auth, storage, and registration logic.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS background alive" --json`

Results:

- PR #63123 `feat(ios): add background alive beacon support`.

Additional query context:

- `gitcrawl search openclaw/openclaw --query "iOS APNs relay push" --json` found PR #81402 with APNs registrations in the SQLite state migration inventory.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS APNs relay background alive push"`

Results:

- No hits.

Additional query context:

- `discrawl search --mode fts --limit 5 "iOS background location"` found a March iOS/watchOS thread where background `nodes location get` depended on APNs wake but failed with `path=no-registration`.
