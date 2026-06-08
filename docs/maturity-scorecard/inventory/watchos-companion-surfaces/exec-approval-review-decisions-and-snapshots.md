---
title: "watchOS companion surfaces - Exec Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Exec Approvals Maturity Note

## Summary

Watch exec approval support is the strongest watchOS-specific feature: the watch can display pending approvals, request snapshots, send allow-once or deny decisions, and receive resolved/expired updates. Coverage is Alpha because source and targeted tests cover the bridge, and archive evidence says maintainers use it, but no repeatable live watch approval scenario is checked in.

Quality is Alpha because the implementation takes security and recovery seriously, while release/support docs still keep the surface internal.

## Category Scope

Included in this category:

- Watch exec approval prompt: Watch exec approval prompt, snapshot, resolve, resolved, and expired payloads
- Watch approval list/detail UI: Watch approval list/detail UI and decision buttons
- iPhone-side prompt caching: iPhone-side prompt caching, watch prompt publishing, snapshot handling, and resolution

## Features

- Watch exec approval prompt: Watch exec approval prompt, snapshot, resolve, resolved, and expired payloads
- Watch approval list/detail UI: Watch approval list/detail UI and decision buttons
- iPhone-side prompt caching: iPhone-side prompt caching, watch prompt publishing, snapshot handling, and resolution

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (54%)`
- Positive signals: Tests cover presenting an approval prompt syncing to watch, snapshot request publishing cached approvals while backgrounded, foreground snapshot skip, pending recovery IDs, clearing recovery IDs, background-aware reconnect paths, stale/unavailable error classification, and prompt retry reset behavior.
- Negative signals: No live proof was found for an actual Gateway exec approval request delivered to an Apple Watch, reviewed on-watch, resolved through the iPhone operator session, and reflected back to the agent.
- Integration gaps: Need a real approval scenario for pending prompt, snapshot request, allow-once, deny, stale/not-found, unavailable allow-always, timeout/expiry, watch reachability change, and notification cleanup.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: `gitcrawl search openclaw/openclaw --query "watch exec approval" --json` did not find a direct watch implementation incident; it returned generic exec approval/watch keyword matches. `gitcrawl search openclaw/openclaw --query "iOS Watch exec approvals" --json` and PR-number searches for older changelog PRs returned no hits from the current gitcrawl store.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "exec-approval on my watch"` found maintainer feedback from 2026-04-17 saying watch exec approval is being used often, plus an earlier security concern that push notifications could expose sensitive information and should open the app/dialog instead. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "watch approval"` found discussion that iOS + watch approval would be useful once released.
- Good qualities: The implementation avoids only notification-text approval by keeping a structured in-app watch review path, persists pending approval bridge state, handles resolved/expired cleanup, and supports background-aware reconnect for watch review/resolve paths.
- Bad qualities: Watch approval is not described as public support. Security-sensitive command text is still a core part of the watch review UI, so redaction/display policy needs a clear product decision before wider release.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (54%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Watch exec approval prompt, Watch approval list/detail UI, iPhone-side prompt caching.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add an end-to-end exec approval scenario using a real Apple Watch and an approval-requiring command.
- Document exactly what command details can appear on the watch and what is withheld from push notifications.
- Add public/internal runbook steps for pending approvals that cannot load because the iPhone operator session is disconnected.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md` and `docs/tools/exec-approvals-advanced.md` document exec approvals generally, not watch-specific review.
- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents iOS internal preview and push flows, but not watch approval usage.

### Source

- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawKit/WatchCommands.swift` defines watch exec approval prompt, resolve, resolved, expired, snapshot, and snapshot-request message types.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/WatchInboxStore.swift` stores and updates watch approval records.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/WatchInboxView.swift` renders approval list/detail screens and Allow Once/Deny buttons.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/WatchConnectivityReceiver.swift` parses approval prompts, resolved/expired updates, snapshots, and sends resolve/snapshot-request payloads.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel.swift` caches approval prompts, publishes watch prompts/snapshots, handles watch resolve events, fetches pending approvals, and resolves through `exec.approval.resolve`.

### Integration tests

- No live watch approval scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/NodeAppModelInvokeTests.swift` covers watch prompt sync, snapshot request behavior, pending recovery IDs, stale/unavailable classification, background-aware reconnect, and retry reset.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/ExecApprovalNotificationBridgeTests.swift` covers iOS exec approval notification parsing and resolved-push cleanup, adjacent to watch approval recovery.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "watch exec approval" --json`

Results:

- No direct current watch approval implementation incident; generic exec approval/watch keyword matches only.

Query:

`gitcrawl search openclaw/openclaw --query "iOS Watch exec approvals" --json`

Results:

- No hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "exec-approval on my watch"`

Results:

- Maintainer feedback from 2026-04-17 says watch exec approval is being used often.
- Earlier 2026-04-03 discussion flagged security risk from sensitive details in push notifications and a plan to move review into an app/dialog.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "watch approval"`

Results:

- Maintainer discussion framed iOS + watch approval as useful once the app is released.
