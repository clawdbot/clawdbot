---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Nextcloud Talk Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Nextcloud Talk Maturity Note

## Summary

Nextcloud Talk is Alpha. It is a bundled webhook bot with docs for `occ talk:bot:install`, shared secret setup, webhook URL, DMs, rooms, reactions, markdown, room lookups, secret files, and config reference. Source and tests cover webhook auth, room info, inbound authorization, monitor replay, send threading, message actions, doctor, and setup. The score stays Alpha because archive evidence shows current invalid-payload, mention-placeholder, file-share, and skipped-message-tool issues.

## Category Scope

- Nextcloud Talk bot installation, shared secret/API credentials, webhook route, room settings, file-backed secrets, and plugin runtime setup.
- Webhook ingress, signature/secret validation, room-vs-DM lookup, DM/group policy, pairing, mention gating, replay protection, and room metadata.
- Outbound markdown/text, URL media fallback, reactions/message actions, threading, status, doctor, setup, and troubleshooting.

## Features

- Nextcloud Talk bot installation: Nextcloud Talk bot installation, shared secret/API credentials, webhook route, room settings, file-backed secrets, and plugin runtime setup
- Webhook ingress: Webhook ingress, signature/secret validation, room-vs-DM lookup, DM/group policy, pairing, mention gating, replay protection, and room metadata
- Outbound markdown/text: Outbound markdown/text, URL media fallback, reactions/message actions, threading, status, doctor, setup, and troubleshooting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: docs cover setup, bot install command, secret files, room policy, capabilities, and config reference; source covers setup, webhook/inbound, authz, room info, monitor, replay guard, send, message actions, doctor, and session routing.
- Negative signals: no recurring live Nextcloud server scenario was found; several current issue threads are runtime/operator failures rather than only theoretical gaps.
- Integration gaps: real Nextcloud AIO/server bot install, webhook POST, room mention detection, file-share event handling, message-tool delivery, API room lookup, and URL media fallback are not proven together in a committed scenario.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: current results include `#81566` invalid payload on non-message Talk events, `#76980` skipped `message` tool, `#66700` mention detection broken by placeholders, `#49869` rich object file-share parsing, and `#79397` structured mention parsing.
- Discrawl reports: 2026-04-01/07 support and GitHub mirror messages show operators hitting `400 Bad Request` `Invalid payload format` during Nextcloud Talk webhook setup and needing precise `occ talk:bot:install` feature guidance.
- Good qualities: docs document webhook reachability, secret files, room lookup caveats, and bot API limitations; source separates API credentials, bot preflight, room info, replay guard, policy, and send behavior.
- Bad qualities: payload diversity, mention encoding, room/DM ambiguity, and bot API setup details are high-friction; docs even call out that the webhook payload does not distinguish DMs vs rooms without API credentials.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Nextcloud server/live bot installation proof is missing.
- The webhook parser and docs need continued hardening for non-message events, file shares, structured mentions, and setup feature spelling/selection.
- Media is URL-based because bot API media uploads are not supported, which limits user expectations compared with richer channels.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/nextcloud-talk.md` lines 8-35 describe bundled/downloadable plugin status.
- `/Users/kevinlin/code/openclaw/docs/channels/nextcloud-talk.md` lines 35-97 document beginner setup, `occ talk:bot:install`, shared secret, webhook URL, secret files, and room/DM lookup caveats.
- `/Users/kevinlin/code/openclaw/docs/channels/nextcloud-talk.md` lines 99-170 document DM access, room policy, capabilities, config reference, media cap, and related docs.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/nextcloud-talk.md` declares `@openclaw/nextcloud-talk` and the `nextcloud-talk` channel surface.

### Source

- `/Users/kevinlin/code/openclaw/extensions/nextcloud-talk/openclaw.plugin.json` declares plugin id `nextcloud-talk` and channel `nextcloud-talk`.
- `/Users/kevinlin/code/openclaw/extensions/nextcloud-talk/package.json` names the package `@openclaw/nextcloud-talk`.
- `/Users/kevinlin/code/openclaw/extensions/nextcloud-talk/src/inbound.ts`, `monitor.ts`, `monitor-runtime.ts`, `signature.ts`, `replay-guard.ts`, and `room-info.ts` implement webhook ingress, monitor/runtime, replay, and room facts.
- `/Users/kevinlin/code/openclaw/extensions/nextcloud-talk/src/send.ts`, `message-actions.ts`, `policy.ts`, `session-route.ts`, and `message-adapter.ts` implement outbound, actions, policy, routing, and adapter behavior.
- `/Users/kevinlin/code/openclaw/extensions/nextcloud-talk/src/setup-core.ts`, `setup-surface.ts`, `doctor.ts`, `api-credentials.ts`, and `bot-preflight.ts` implement setup, doctor, credentials, and bot preflight behavior.

### Integration tests

- No committed live Nextcloud Talk server scenario was found under `/Users/kevinlin/code/openclaw/qa` or `/Users/kevinlin/code/openclaw/test`.
- `/Users/kevinlin/code/openclaw/extensions/nextcloud-talk/src/channel.lifecycle.test.ts`, `monitor.replay.test.ts`, and `send.cfg-threading.test.ts` cover runtime-like lifecycle, replay, and delivery contracts with local mocks.
- `/Users/kevinlin/code/openclaw/extensions/nextcloud-talk/src/send.cfg-threading.test.ts` records proof results for text, media, and replyTo capability handling.

### Unit tests

- Nextcloud Talk has 15 focused tests, including `accounts.test.ts`, `approval-auth.test.ts`, `bot-preflight.test.ts`, `channel.core.test.ts`, `channel.status.test.ts`, `core.test.ts`, `doctor.test.ts`, `inbound.authz.test.ts`, `inbound.behavior.test.ts`, `message-actions.test.ts`, `room-info.test.ts`, and `setup.test.ts`.

### Gitcrawl queries

Query: `nextcloud-talk`

Results:

- `#79397` open PR: `fix(nextcloud-talk): parse structured mention payloads`.
- `#81566` open issue: `nextcloud-talk channel returns 400 "Invalid payload format" on non-message Talk events (file shares)`.
- `#76980` open issue: `Nextcloud Talk channel agent silently skips message tool, marks reply completed without posting`.
- `#66700` open issue: `NC Talk plugin: mention detection broken due to {mention-user1} placeholders`.
- `#49869` open PR: `fix(nextcloud-talk): parse rich object file shares from webhook payload`.

Query: `Nextcloud Talk webhook room reaction bot setup`

Results:

- `#76980` was returned again as the main focused result for this query.

### Discrawl queries

Query: `Nextcloud Talk invalid payload`

Results:

- 2026-04-07 GitHub mirror comments on issue `#34111` show `400 Bad Request` / `Invalid payload format` during webhook setup and mention feature configuration confusion.
- 2026-04-01 support thread reported a Nextcloud AIO/Raspberry Pi setup stuck on the same invalid-payload webhook error.

Query: `nextcloud talk`

Results:

- 2026-05-21 user discussion referenced multi-agent rooms built in Nextcloud Talk and Matrix but not yet generalized into a maintained feature.
