---
title: "watchOS companion surfaces - Delivery and Recovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Delivery and Recovery Maturity Note

## Summary

The watch approval path depends on the iPhone waking, reconnecting, fetching pending approval state, and cleaning up resolved/stale approval prompts. Source and tests cover important pieces of that recovery path. Coverage is Alpha at the lower boundary because the recovery logic is implemented and tested in pieces, but no TestFlight/APNs/watch proof is checked in.

Quality is Alpha because the design accounts for relay-backed push, direct APNs, stale cleanup, and pending recovery IDs, but the operational setup remains complex and internal.

## Category Scope

Included in this category:

- APNs relay/direct registration as it affects: APNs relay/direct registration as it affects watch approval wake/recovery
- Silent push: Silent push, background refresh, and significant-location wake paths
- Pending approval recovery IDs: Pending approval recovery IDs, snapshot refresh, and resolved/stale cleanup
- Gateway-side iOS exec approval: Gateway-side iOS exec approval APNs targeting
- iPhone-side WatchConnectivity transport: iPhone-side WatchConnectivity transport and status snapshot
- Watch-side receiver activation: Watch-side receiver activation and inbound payload handling
- Delivery fallback among reachable messages: Delivery fallback among reachable messages, queued user info, and application context snapshots

## Features

- APNs relay/direct registration as it affects: APNs relay/direct registration as it affects watch approval wake/recovery
- Silent push: Silent push, background refresh, and significant-location wake paths
- Pending approval recovery IDs: Pending approval recovery IDs, snapshot refresh, and resolved/stale cleanup
- Gateway-side iOS exec approval: Gateway-side iOS exec approval APNs targeting
- iPhone-side WatchConnectivity transport: iPhone-side WatchConnectivity transport and status snapshot
- Watch-side receiver activation: Watch-side receiver activation and inbound payload handling
- Delivery fallback among reachable messages: Delivery fallback among reachable messages, queued user info, and application context snapshots

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (50%)`
- Positive signals: iOS tests cover background-aware reconnect for watch and push paths, pending recovery ID hydration, resolved-push notification cleanup, and background alive trigger normalization. Gateway tests cover iOS APNs approval targeting, relay/direct auth decisions, and registration filtering.
- Negative signals: No live APNs, TestFlight, or real watch recovery scenario was found.
- Integration gaps: Need an official/TestFlight build scenario with relay-backed APNs, a backgrounded iPhone, a reachable watch, a pending approval, push wake, watch snapshot load, watch resolve, and resolved-push cleanup.

## Quality Score

- Score: `Alpha (60%)`
- Gitcrawl reports: `gitcrawl search openclaw/openclaw --query "iOS Watch exec approvals" --json` returned no hits, and direct PR-number searches for older watch changelog items returned no hits. This absence is neutral after successful freshness and feature-specific queries.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"` found a PR #61757 review comment warning that foreground snapshot-request skipping could leave recovery IDs stuck after a failed push request. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchOS support"` summarized background behavior as limited by iOS and said watchOS exec approvals need manual compilation plus local APNs config.
- Good qualities: The implementation treats background recovery as a distinct path, persists pending approval recovery IDs, cleans up resolved notifications, distinguishes direct versus relay APNs, and requires operator approval scope before Gateway approval pushes target iOS devices.
- Bad qualities: The setup crosses Apple entitlements, APNs relay/direct config, Gateway operator scope, iOS background limits, and WatchConnectivity. That is too complex for a public feature without a runbook and release smoke.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (50%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for APNs relay/direct registration as it affects, Silent push, Pending approval recovery IDs, Gateway-side iOS exec approval, iPhone-side WatchConnectivity transport, Watch-side receiver activation, Delivery fallback among reachable messages.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live APNs/watch approval recovery runbook and proof artifact.
- Document direct APNs versus relay-backed behavior specifically for watch approval recovery.
- Add a regression scenario for the foreground snapshot-request recovery gap discussed in PR #61757.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents relay-backed push, direct APNs for local/manual builds, background alive beacons, and relay trust model.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` documents APNs expectations for local/manual builds and official builds.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel.swift` handles silent push wakes, background refresh wakes, significant-location wakes, APNs registration, push-relay gateway identity, exec approval requested/resolved pushes, pending watch recovery IDs, and watch snapshot sync.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Push/ExecApprovalNotificationBridge.swift` parses exec approval notification payloads and removes matching notifications.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Push/PushRegistrationManager.swift` and `PushRelayClient.swift` implement relay/direct registration support.
- `/Users/kevinlin/code/openclaw/src/gateway/exec-approval-ios-push.ts` targets paired iOS/iPadOS operator devices with `operator.approvals` scope and sends direct or relay APNs approval alerts/resolved wakes.

### Integration tests

- No live APNs or real watch recovery scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/NodeAppModelInvokeTests.swift` covers background-aware watch/push reconnect selection and pending watch recovery behavior.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/ExecApprovalNotificationBridgeTests.swift` covers resolved-push cleanup.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/BackgroundAliveBeaconTests.swift` covers wake trigger normalization.
- `/Users/kevinlin/code/openclaw/src/gateway/exec-approval-ios-push.test.ts` covers Gateway-side APNs target selection, operator approval scope, direct/relay config handling, and delivery accounting.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS Watch exec approvals" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "61757" --json`

Results:

- No hits from the local gitcrawl store.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"`

Results:

- PR #61757 review comment highlighted a recovery gap where skipping watch snapshot requests in foreground could leave pending recovery IDs stuck after a failed push request.
- Discord summary said no public TestFlight path exists and watchOS exec approvals need manual build/APNs setup.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchOS support"`

Results:

- Maintainer-preview summary flagged iOS background limits, manual APNs config, and lack of public TestFlight.
