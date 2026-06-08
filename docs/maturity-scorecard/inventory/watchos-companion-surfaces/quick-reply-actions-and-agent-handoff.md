---
title: "watchOS companion surfaces - Quick Reply Actions and Agent Handoff Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Quick Reply Actions and Agent Handoff Maturity Note

## Summary

Watch prompt actions can flow back to the iPhone as `watch.reply` events, then the iOS node queues or forwards them into the selected OpenClaw session as a low-thinking agent deep link. Coverage is Experimental because the offline queue path is unit-tested, but a complete watch button to agent turn proof was not found.

Quality is Alpha because the handoff has dedupe, offline queueing, session keys, and mirrored notification fallback, but delivery semantics are not documented for users.

## Category Scope

- Watch action buttons from generic prompt notifications.
- Watch-to-iPhone reply payloads.
- iPhone-side dedupe, offline queueing, and agent request forwarding.
- Mirrored iOS notification action fallback.
- Out of scope: exec approval-specific allow/deny decisions.

## Features

- Watch action buttons from generic prompt: Watch action buttons from generic prompt notifications
- Watch-to-iPhone reply payloads: Watch-to-iPhone reply payloads behavior, status, and operator-visible verification.
- iPhone-side dedupe: iPhone-side dedupe, offline queueing, and agent request forwarding
- Mirrored iOS notification action: Mirrored iOS notification action fallback

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (44%)`
- Positive signals: Source implements watch reply encoding/decoding, direct or queued WatchConnectivity delivery, iPhone-side dedupe, gateway-offline queueing, queue drain on reconnect, and agent deep-link forwarding.
- Negative signals: Only one direct test for queueing a watch reply while offline was found. No live scenario proves a watch action produces the intended agent message in the intended session.
- Integration gaps: Need a real watch button scenario for immediate delivery, queued delivery, duplicate reply suppression, gateway reconnect drain, session-key routing, and failure requeue.

## Quality Score

- Score: `Alpha (57%)`
- Gitcrawl reports: `gitcrawl search openclaw/openclaw --query "watch reply" --json` returned mostly unrelated reply/watch keyword results and a Wear OS PR, not current watchOS reply bugs. `gitcrawl search openclaw/openclaw --query "watch quick-action notification" --json` returned a Wear OS quick-reply result, not the Apple Watch path.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"` found user interest in quick voice responses and watch notifications. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "watch reply"` did not surface current Apple Watch quick-reply incidents.
- Good qualities: Replies carry reply ID, prompt ID, action ID, action label, session key, note, timestamp, and transport. The iPhone side dedupes by reply ID and queues when the Gateway is offline.
- Bad qualities: The agent handoff turns a watch tap into a generated agent message, which needs clearer user-facing wording and auditability. There is no operator explanation for queued replies or failed forwarding.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Experimental (44%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Watch action buttons from generic prompt, Watch-to-iPhone reply payloads, iPhone-side dedupe, Mirrored iOS notification action.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add an e2e proof that a watch action button reaches the expected OpenClaw session exactly once.
- Document what the agent sees from a watch reply and how session routing works.
- Add tests for duplicate reply IDs, queue drain, failure requeue, and mirrored iOS notification actions.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` does not document watch quick replies.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` does not document watch quick reply behavior.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/WatchConnectivityReceiver.swift` builds `watch.reply` payloads and sends them through `sendMessage` or `transferUserInfo`.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Services/WatchMessagingPayloadCodec.swift` parses quick reply payloads into `WatchQuickReplyEvent`.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/WatchReplyCoordinator.swift` dedupes reply IDs, queues replies while disconnected, drains on reconnect, and supports requeue on forward failure.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel.swift` handles watch quick replies and forwards them as agent deep links.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/OpenClawApp.swift` routes mirrored iOS notification watch prompt actions into the same reply bridge.

### Integration tests

- No watch action to agent-turn live or integration scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/NodeAppModelInvokeTests.swift` includes `watchReplyQueuesWhenGatewayOffline`.
- No direct tests were found for duplicate suppression, reconnect drain, successful agent forwarding, or mirrored notification action parsing.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "watch reply" --json`

Results:

- Mostly unrelated reply/watch keyword results and a Wear OS PR; no current Apple Watch quick-reply bug surfaced.

Query:

`gitcrawl search openclaw/openclaw --query "watch quick-action notification" --json`

Results:

- Wear OS quick-reply result only; no Apple Watch path hit.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"`

Results:

- User interest included Apple Watch notifications and quick voice responses; no public support path was identified.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "watch reply"`

Results:

- No current Apple Watch quick-reply implementation incident surfaced.
