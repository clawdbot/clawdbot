---
title: "watchOS companion surfaces - Watchconnectivity Session Status and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Watchconnectivity Session Status and Delivery Maturity Note

## Summary

The iPhone side exposes a WatchConnectivity service that reports support, pairing, install, reachability, and activation state, then delivers watch payloads through `sendMessage`, `transferUserInfo`, or `applicationContext`. Coverage is Experimental because source and unit-adjacent command tests exist, but no real phone-watch session scenario was found.

Quality is Alpha because the transport code has reasonable fallback behavior and status emission, while docs and operator repair guidance are sparse.

## Category Scope

- iPhone-side WatchConnectivity transport and status snapshot.
- Watch-side receiver activation and inbound payload handling.
- Delivery fallback among reachable messages, queued user info, and application context snapshots.
- Out of scope: the content semantics of watch notifications and approval decisions.

## Features

- iPhone-side WatchConnectivity transport: iPhone-side WatchConnectivity transport and status snapshot
- Watch-side receiver activation: Watch-side receiver activation and inbound payload handling
- Delivery fallback among reachable messages: Delivery fallback among reachable messages, queued user info, and application context snapshots

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (46%)`
- Positive signals: Source implements status snapshots, activation wait loops, reachability change handling, send-message fallback to queued delivery, and watch-side activation/reception. iOS node invoke tests cover `watch.status` and `watch.notify` service routing through a mock watch service.
- Negative signals: No WatchConnectivity integration test, simulator pair test, or real iPhone plus Apple Watch test artifact was found.
- Integration gaps: Need a real device scenario for pairing state, watch app installed state, reachable foreground delivery, queued background delivery, application-context snapshot delivery, and session reactivation.

## Quality Score

- Score: `Alpha (60%)`
- Gitcrawl reports: `gitcrawl search openclaw/openclaw --query "WatchConnectivity" --json` returned no hits. `gitcrawl search openclaw/openclaw --query "iOS Watch reply reliability" --json` also returned no hits.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchConnectivity"` returned older non-current OpenClaw-adjacent design discussion rather than current implementation incidents. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS / WatchOS"` showed ongoing watch support work and release-date questions, not a resolved public support baseline.
- Good qualities: The transport distinguishes unsupported, unpaired, app-not-installed, reachable, and activation states. It falls back from `sendMessage` to queued delivery and logs status transitions.
- Bad qualities: Watch connectivity failure messages are mostly implementation errors/status fields; there is no user-facing watch repair runbook. The code depends on iOS/watchOS runtime behavior that is not captured by local tests.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Experimental (46%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for iPhone-side WatchConnectivity transport, Watch-side receiver activation, Delivery fallback among reachable messages.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a WatchConnectivity QA path for foreground and background delivery.
- Document what operators should do for unpaired, not installed, not reachable, and inactive states.
- Add real-device proof around reactivation after session deactivation.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents iOS app pairing and push, but does not document watch pairing or WatchConnectivity repair.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` documents source install and beta release, but not watch transport diagnostics.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Services/WatchConnectivityTransport.swift` implements iPhone-side status snapshots, activation, status handlers, `sendPayload`, `sendSnapshotPayload`, and WCSession delegate callbacks.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Services/WatchMessagingService.swift` wraps the transport as `WatchMessagingServicing`.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/WatchConnectivityReceiver.swift` activates WCSession on the watch, receives messages/user info/application context, and sends replies or approval resolutions back to the iPhone.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Services/NodeServiceProtocols.swift` defines `WatchMessagingStatus`, `WatchQuickReplyEvent`, and watch approval event types.

### Integration tests

- No WatchConnectivity real-device, simulator, or integration scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/NodeAppModelInvokeTests.swift` covers `watch.status` returning a mocked service snapshot and `watch.notify` routing to a mocked service.
- No tests directly instantiate `WatchConnectivityTransport` or `WatchConnectivityReceiver`.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "WatchConnectivity" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "iOS Watch reply reliability" --json`

Results:

- No hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchConnectivity"`

Results:

- Returned older non-current OpenClaw-adjacent WatchConnectivity planning content, not current product incidents.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS / WatchOS"`

Results:

- The active Discord channel had recent release/support questions and comments about improving watch support, indicating ongoing work rather than stable support.
