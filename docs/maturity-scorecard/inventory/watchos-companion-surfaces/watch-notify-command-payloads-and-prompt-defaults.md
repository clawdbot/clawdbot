---
title: "watchOS companion surfaces - Notifications and Replies Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Notifications and Replies Maturity Note

## Summary

The iOS node advertises a `watch` capability and exposes `watch.status` plus `watch.notify`, with typed payloads, priority/risk normalization, action capping, and default prompt/approval actions. Coverage is Alpha at the boundary because command handling is implemented and unit-tested through the iOS node model, but it lacks a real Gateway-to-iPhone-to-Watch proof.

Quality is Alpha because the command contract is typed and constrained, while the operator-facing docs are not watch-specific.

## Category Scope

Included in this category:

- watch.status: watch.status and watch.notify command contracts
- Payload normalization: Payload normalization for title/body, prompt/session metadata, priority, risk, and action buttons
- Mirrored iOS notification fallback when watch: Mirrored iOS notification fallback when watch delivery is queued
- Watch action buttons from generic prompt: Watch action buttons from generic prompt notifications
- Watch-to-iPhone reply payloads: Watch-to-iPhone reply payloads behavior, status, and operator-visible verification.
- iPhone-side dedupe: iPhone-side dedupe, offline queueing, and agent request forwarding
- Mirrored iOS notification action: Mirrored iOS notification action fallback

## Features

- watch.status: watch.status and watch.notify command contracts
- Payload normalization: Payload normalization for title/body, prompt/session metadata, priority, risk, and action buttons
- Mirrored iOS notification fallback when watch: Mirrored iOS notification fallback when watch delivery is queued
- Watch action buttons from generic prompt: Watch action buttons from generic prompt notifications
- Watch-to-iPhone reply payloads: Watch-to-iPhone reply payloads behavior, status, and operator-visible verification.
- iPhone-side dedupe: iPhone-side dedupe, offline queueing, and agent request forwarding
- Mirrored iOS notification action: Mirrored iOS notification action fallback

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (50%)`
- Positive signals: The iOS node advertises watch commands when the watch capability is present. Unit tests cover `watch.status`, `watch.notify`, empty-message rejection, default actions, approval defaults, priority/risk derivation, action capping, and unavailable delivery errors.
- Negative signals: No integration test was found that invokes `watch.notify` through a live Gateway into an iPhone and verifies the payload appears on an Apple Watch or mirrored local notification.
- Integration gaps: Need a live command scenario for successful reachable delivery, queued delivery, mirrored notification fallback, invalid payload rejection, and action rendering.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: `gitcrawl search openclaw/openclaw --query "watch.notify" --json` did not find direct current watch notify incidents; related hits were generic notification/watch keyword matches and #46664 for future mobile offline queue behavior.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"` found a TestFlight request for notifications and quick voice responses, which reinforces user interest but also the lack of public support. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchOS support"` says WatchOS paths are usable from source but still maintainer-preview.
- Good qualities: Typed models live in shared OpenClawKit. Normalization trims untrusted text fields, derives risk/priority, caps actions to four, and supplies approval/non-approval defaults only when a prompt ID exists.
- Bad qualities: There is no public command reference for `watch.status` or `watch.notify`. The fallback to mirrored iOS notification is useful but adds another delivery surface whose user behavior is not documented.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (50%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for watch.status, Payload normalization, Mirrored iOS notification fallback when watch, Watch action buttons from generic prompt, Watch-to-iPhone reply payloads, iPhone-side dedupe, Mirrored iOS notification action.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Document the watch command schema, default action behavior, and unsupported/unavailable errors.
- Add a Gateway `node.invoke watch.notify` scenario with a physical watch and mirrored-notification fallback.
- Clarify whether `watch.notify` is a public node capability or a maintainer/internal preview API.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents the iOS node app but does not list `watch.status` or `watch.notify`.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` describes internal beta/source-build status.

### Source

- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawKit/WatchCommands.swift` defines `OpenClawWatchCommand`, watch payload types, risk levels, action models, status payloads, notify params, and notify result payloads.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Gateway/GatewayConnectionController.swift` advertises `watch.status` and `watch.notify` when the watch capability is present and includes watch status fields in permissions.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel.swift` handles `watch.status` and `watch.notify`.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel+WatchNotifyNormalization.swift` normalizes watch notification params and default actions.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/OpenClawApp.swift` defines `WatchPromptNotificationBridge` for mirrored iOS notifications when delivery is queued.

### Integration tests

- No live `node.invoke watch.notify` scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/NodeAppModelInvokeTests.swift` covers `handleInvokeWatchStatusReturnsServiceSnapshot`, `handleInvokeWatchNotifyRoutesToWatchService`, empty-message rejection, default actions, approval defaults, priority/risk derivation, action capping, and unavailable delivery.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "watch.notify" --json`

Results:

- No direct current watch notify incident; related hits were generic notification/watch keyword matches and #46664 for future mobile queue behavior.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"`

Results:

- TestFlight/access request mentions Apple Watch companion notifications and quick voice responses as desired usage.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchOS support"`

Results:

- Maintainer-preview summary says iOS and WatchOS source paths exist but are not a public TestFlight path.
