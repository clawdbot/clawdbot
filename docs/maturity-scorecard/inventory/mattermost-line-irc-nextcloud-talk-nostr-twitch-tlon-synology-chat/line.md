---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Webhook Messaging Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Webhook Messaging Maturity Note

## Summary

LINE is a Beta channel in this surface. Docs and source cover Messaging API setup, webhook signature verification, token/secret files, DM and group policy, rich messages, Flex cards, locations, media, ACP bindings, and outbound media. It stays below Stable because current archive evidence still shows multi-account route, webhook route, media size, and rate-limit edge cases.

## Category Scope

Included in this category:

- LINE Messaging API webhook setup: LINE Messaging API webhook setup, channel access token/channel secret handling, multi-account routing, and plugin install
- Signed inbound webhook events: Signed inbound webhook events, immediate acknowledgement, DM/group authorization, pairing, group keys, message context, redelivery dedupe, and durable reply delivery
- Rich LINE payloads: Rich LINE payloads, quick replies, locations, Flex/template cards, outbound image/audio/video media, rich menus, status, and troubleshooting
- Nextcloud Talk bot installation: Nextcloud Talk bot installation, shared secret/API credentials, webhook route, room settings, file-backed secrets, and plugin runtime setup
- Webhook ingress: Webhook ingress, signature/secret validation, room-vs-DM lookup, DM/group policy, pairing, mention gating, replay protection, and room metadata
- Outbound markdown/text: Outbound markdown/text, URL media fallback, reactions/message actions, threading, status, doctor, setup, and troubleshooting
- Synology Chat incoming/outgoing webhook setup: Synology Chat incoming/outgoing webhook setup, token/incoming URL config, env vars, setup surface, and multi-account route config
- Webhook token verification: Webhook token verification, DM policy, allowed user IDs, pairing, rate limiting, invalid-token lockout, session keys, direct-message inbound context, and webhook ACK semantics
- Outbound text: Outbound text and URL media delivery, private-network SSRF guards, security audit, setup/status, and troubleshooting

## Features

- LINE Messaging API webhook setup: LINE Messaging API webhook setup, channel access token/channel secret handling, multi-account routing, and plugin install
- Signed inbound webhook events: Signed inbound webhook events, immediate acknowledgement, DM/group authorization, pairing, group keys, message context, redelivery dedupe, and durable reply delivery
- Rich LINE payloads: Rich LINE payloads, quick replies, locations, Flex/template cards, outbound image/audio/video media, rich menus, status, and troubleshooting
- Nextcloud Talk bot installation: Nextcloud Talk bot installation, shared secret/API credentials, webhook route, room settings, file-backed secrets, and plugin runtime setup
- Webhook ingress: Webhook ingress, signature/secret validation, room-vs-DM lookup, DM/group policy, pairing, mention gating, replay protection, and room metadata
- Outbound markdown/text: Outbound markdown/text, URL media fallback, reactions/message actions, threading, status, doctor, setup, and troubleshooting
- Synology Chat incoming/outgoing webhook setup: Synology Chat incoming/outgoing webhook setup, token/incoming URL config, env vars, setup surface, and multi-account route config
- Webhook token verification: Webhook token verification, DM policy, allowed user IDs, pairing, rate limiting, invalid-token lockout, session keys, direct-message inbound context, and webhook ACK semantics
- Outbound text: Outbound text and URL media delivery, private-network SSRF guards, security audit, setup/status, and troubleshooting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (75%)`
- Positive signals: docs and source cover install/setup, webhook signature verification, ack behavior, access control, media downloads, rich payloads, outbound media, ACP bindings, status, setup, and account handling.
- Negative signals: no committed live LINE Messaging API e2e run was found; fresh issues still cover webhook route registration, multi-account defaults, media prechecks, and chunk-idle timeout behavior.
- Integration gaps: live webhook verification, signed POST, DM/group admission, media download, rich card delivery, and outbound media proof are not captured as a recurring scenario.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: query results include open PRs/issues for `accounts.default` loading and named-account default enablement, multi-account webhook route 404s, credential secret targets, outbound media precheck, and inbound media chunk-idle timeout.
- Discrawl reports: archive messages include a LINE webhook route case/registry review from 2026-04-25 and a closed issue for the webhook route not registered in the gateway HTTP handler.
- Good qualities: raw-body signature handling is explicit, webhook ACK behavior is documented, token/secret file handling rejects symlinks, media URL SSRF protections are documented, and redelivery dedupe appears in source.
- Bad qualities: multi-account route registration, webhook path casing, signed raw-body handling, media size, and upstream retry/rate-limit semantics are subtle and have generated repeated repair work.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Beta (75%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for LINE Messaging API webhook setup, Signed inbound webhook events, Rich LINE payloads, Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- A real LINE developer-console webhook run is not checked in for setup, signed inbound events, media, rich messages, and outbound media.
- Multi-account route behavior needs continued proof because route registration and default-account semantics have had recent bugs.
- Docs are broad, but the operational failure modes around LINE retry/rate limits and media URLs need stronger scenario capture.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/line.md` lines 10-18 describe the LINE Messaging API webhook receiver and supported direct messages, groups, media, locations, Flex messages, and templates.
- `/Users/kevinlin/code/openclaw/docs/channels/line.md` lines 32-54 document setup, webhook URL, signature validation, body limits, and raw request byte handling.
- `/Users/kevinlin/code/openclaw/docs/channels/line.md` lines 56-145 document token/secret config, file-backed credentials, multi-account paths, DM/group access control, and group-policy defaults.
- `/Users/kevinlin/code/openclaw/docs/channels/line.md` lines 153-226 document message behavior, media download caps, rich messages, ACP support, outbound media, and media URL SSRF restrictions.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/line.md` declares `@openclaw/line` and the `line` channel surface.

### Source

- `/Users/kevinlin/code/openclaw/extensions/line/openclaw.plugin.json` declares plugin id `line` and channel `line`.
- `/Users/kevinlin/code/openclaw/extensions/line/package.json` names the package `@openclaw/line`.
- `/Users/kevinlin/code/openclaw/extensions/line/src/webhook.ts`, `webhook-node.ts`, `signature.ts`, `bot-handlers.ts`, and `monitor.ts` implement webhook ingress, signature checks, bot-event handling, and monitor lifecycle.
- `/Users/kevinlin/code/openclaw/extensions/line/src/group-policy.ts`, `group-keys.ts`, `bot-access.ts`, `accounts.ts`, and `config-schema.ts` implement authorization and config.
- `/Users/kevinlin/code/openclaw/extensions/line/src/outbound.ts`, `outbound-media.ts`, `reply-payload-transform.ts`, `flex-templates/*`, `rich-menu.ts`, and `send.ts` implement rich/outbound delivery.

### Integration tests

- No committed live LINE Messaging API scenario was found under `/Users/kevinlin/code/openclaw/qa` or `/Users/kevinlin/code/openclaw/test`.
- `/Users/kevinlin/code/openclaw/extensions/line/src/monitor.lifecycle.test.ts` exercises webhook route registration and lifecycle behavior with mocked runtime dependencies.
- `/Users/kevinlin/code/openclaw/extensions/line/src/webhook-node.test.ts` covers the shared POST contract, authenticated request release callback, raw payload handling, and middleware payload behavior.
- `/Users/kevinlin/code/openclaw/extensions/line/src/channel.sendPayload.test.ts` records adapter capability proof results for text, media, message-sending hooks, and receive ACK policies.

### Unit tests

- LINE has 24 focused extension tests, including `accounts.test.ts`, `auto-reply-delivery.test.ts`, `bot-handlers.test.ts`, `bot-message-context.test.ts`, `config-schema.test.ts`, `download.test.ts`, `group-keys.test.ts`, `markdown-to-line.test.ts`, `message-cards.test.ts`, `outbound-media.test.ts`, `reply-chunks.test.ts`, `reply-payload-transform.test.ts`, `rich-menu.test.ts`, `send.test.ts`, `setup-surface.test.ts`, and `signature.test.ts`.
- `/Users/kevinlin/code/openclaw/test/vitest/vitest.extension-line.config.ts` defines a dedicated scoped LINE extension lane.

### Gitcrawl queries

Query: `line`

Results:

- `#81471` open PR: `fix(line): load accounts.default and default-enable named accounts`.
- `#47264` open issue: `LINE plugin: multi-account mode breaks webhook route registration (404)`.
- `#85003` open PR: `fix(line): register credential secret targets`.
- `#84229` open PR: `fix(line): precheck outbound LINE media size`.
- `#86873` open PR: `fix(line): add chunk-idle timeout to inbound media download`.

Query: `LINE webhook setup routing media flex`

Results:

- `#65656` open issue: `LINE reply - table flex messages silently dropped with 429 when text + table are returned together`.

### Discrawl queries

Query: `LINE webhook route`

Results:

- 2026-04-25 GitHub mirror message closed PR `#48120` about LINE webhook route path casing on Windows as not reproducible on current main.
- 2026-04-25 archive also included closure of issue `#49803` for LINE plugin webhook route not registered in the gateway HTTP handler.

Query: `LINE group media`

Results:

- No focused operational LINE group/media support transcript was returned in the displayed top results; the relevant current evidence is in gitcrawl issues/PRs and source.
