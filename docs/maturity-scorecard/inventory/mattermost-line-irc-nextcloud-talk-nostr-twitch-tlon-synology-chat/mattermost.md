---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Workspace Chat Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Workspace Chat Maturity Note

## Summary

Mattermost is one of the stronger channels in this long-tail surface. It has first-class docs, a downloadable plugin, WebSocket receive, bot-token setup, slash commands, threads, draft preview streaming, reactions, interactive buttons, directory lookup, multi-account config, and a large extension test suite. It remains Beta rather than Stable because current archive evidence still includes thread-root, no-visible-reply, slash callback auth, and interaction-token hardening churn.

## Category Scope

Included in this category:

- Mattermost bot account setup: Mattermost bot account setup, bot token/base URL configuration, multi-account config, and plugin packaging
- WebSocket inbound monitoring: WebSocket inbound monitoring, DM/channel routing, access control, pairing, mention gating, and session threading
- Outbound delivery: Outbound delivery, draft preview streaming, reactions, interactive buttons, slash commands, directory lookup, diagnostics, and doctor behavior

## Features

- Mattermost bot account setup: Mattermost bot account setup, bot token/base URL configuration, multi-account config, and plugin packaging
- WebSocket inbound monitoring: WebSocket inbound monitoring, DM/channel routing, access control, pairing, mention gating, and session threading
- Outbound delivery: Outbound delivery, draft preview streaming, reactions, interactive buttons, slash commands, directory lookup, diagnostics, and doctor behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: docs cover install, setup, slash callbacks, DMs, groups, threading, outbound targets, streaming, reactions, buttons, directory lookup, multi-account, and troubleshooting; source has a broad plugin with monitor, send, slash, interaction, reconnect, doctor, setup, auth, and directory modules.
- Negative signals: live server proof is ad hoc rather than recurring; archive evidence includes user-visible thread/context regressions and no-visible-reply diagnostics.
- Integration gaps: no committed live Mattermost server scenario or e2e route proving setup-to-message-to-reply across slash commands, thread replies, buttons, and streaming in one run.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: query results include open PRs for `/model` dialog picker, interaction-token hardening, slash callback auth hardening, thread starter hydration, automatic ack reactions, and thread-root reply resolution.
- Discrawl reports: a 2026-05-27 maintainer message reported a dev-claw Mattermost channel working; 2026-05-20 user support reported lost thread context in old Mattermost threads; 2026-03-25/28 archive entries described invalid `RootId` failures and silent drops.
- Good qualities: strong docs/source alignment, explicit fail-closed slash callback validation, HMAC button verification, direct-channel retry, streaming finalization fallback, and focused diagnostics for no-visible replies.
- Bad qualities: thread semantics, slash callback state, interaction auth, and self-hosted callback reachability remain operationally fragile and continue to generate bug-fix traffic.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Mattermost bot account setup, WebSocket inbound monitoring, Outbound delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Recurring live Mattermost scenario proof is missing for first-time setup, WebSocket receive, thread reply, slash command, button callback, reaction, and draft-stream finalization.
- Self-hosted callback URLs and Mattermost server config (`AllowedUntrustedInternalConnections`, post action integration, slash command tokens) remain frequent operator footguns.
- Multi-team directory lookup and old-thread context are still visible risk areas.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/mattermost.md` lines 10-31 describe status, install, and quick setup.
- `/Users/kevinlin/code/openclaw/docs/channels/mattermost.md` lines 62-101 document native slash commands, callback URL behavior, and command-token validation.
- `/Users/kevinlin/code/openclaw/docs/channels/mattermost.md` lines 185-220 document DM access control, group policy, and outbound targets.
- `/Users/kevinlin/code/openclaw/docs/channels/mattermost.md` lines 266-480 document draft preview streaming, reactions, interactive buttons, HMAC button verification, and directory adapter behavior.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/mattermost.md` declares `@openclaw/mattermost` and the `mattermost` channel surface.

### Source

- `/Users/kevinlin/code/openclaw/extensions/mattermost/openclaw.plugin.json` declares plugin id `mattermost` and channel `mattermost`.
- `/Users/kevinlin/code/openclaw/extensions/mattermost/package.json` names the package `@openclaw/mattermost`.
- `/Users/kevinlin/code/openclaw/extensions/mattermost/src/mattermost/monitor.ts`, `monitor-auth.ts`, `monitor-websocket.ts`, and `monitor-slash.ts` implement inbound WebSocket and slash monitoring paths.
- `/Users/kevinlin/code/openclaw/extensions/mattermost/src/mattermost/send.ts`, `reply-delivery.ts`, `draft-stream.ts`, `reactions.ts`, `interactions.ts`, and `target-resolution.ts` implement outbound delivery, streaming, reactions, buttons, and target resolution.
- `/Users/kevinlin/code/openclaw/extensions/mattermost/src/setup-core.ts`, `setup-surface.ts`, `doctor.ts`, and `config-schema-core.ts` implement setup, status, doctor, and config behavior.

### Integration tests

- No committed live Mattermost server e2e or QA scenario was found under `/Users/kevinlin/code/openclaw/qa` or `/Users/kevinlin/code/openclaw/test`.
- `/Users/kevinlin/code/openclaw/extensions/mattermost/src/channel.message-adapter.test.ts` validates adapter capability proofs for draft preview/finalizer behavior.
- `/Users/kevinlin/code/openclaw/extensions/mattermost/src/mattermost/monitor-websocket.test.ts`, `slash-http.test.ts`, and `reply-delivery.test.ts` exercise runtime boundaries with mocked Mattermost clients and HTTP requests.

### Unit tests

- Mattermost has 39 component tests in the extension tree, including `approval-auth.test.ts`, `config-schema.test.ts`, `doctor.test.ts`, `setup.test.ts`, `monitor-auth.test.ts`, `monitor-gating.test.ts`, `reconnect.test.ts`, `slash-commands.test.ts`, `slash-state.test.ts`, `interactions.test.ts`, `directory.test.ts`, and `no-visible-reply-diagnostic.test.ts`.
- `/Users/kevinlin/code/openclaw/src/commands/status-all/channels.mattermost-token-summary.test.ts` covers status-token summary behavior.

### Gitcrawl queries

Query: `mattermost`

Results:

- `#83573` open PR: `feat(mattermost): add /model dialog picker`.
- `#64546` open PR: `fix: Mattermost interaction token forgeable via hardcoded HMAC...`.
- `#65655` open PR: `fix: harden Mattermost slash callback auth`.
- `#73061` open PR: `fix(mattermost): hydrate thread starter context`.
- `#80426` open PR: `feat(mattermost): add automatic ack reactions`.
- `#76634` open PR: `fix(mattermost): resolve reply root before sending thread replies`.

Query: `Mattermost bug auth token thread reply no visible`

Results:

- Search returned broader cross-channel maintenance traffic, including `#74163`; the more useful Mattermost-specific current archive signal came from the simple `mattermost` query above.

### Discrawl queries

Query: `mattermost`

Results:

- 2026-05-27 maintainer channel message reported a quick smoke test with a dev claw and the Mattermost channel looked OK.
- 2026-05-20 Mattermost support message reported old-thread and initial-post context loss.

Query: `Mattermost no visible reply thread`

Results:

- 2026-03-28 GitHub mirror message for PR `#56305` described stale Mattermost `RootId` causing silent no-response behavior.
- 2026-03-25 Mattermost support discussion described multi-turn thread failures caused by invalid `RootId` behavior.
