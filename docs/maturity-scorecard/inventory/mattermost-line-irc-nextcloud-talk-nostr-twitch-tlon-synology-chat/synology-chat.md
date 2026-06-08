---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Synology Chat Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Synology Chat Maturity Note

## Summary

Synology Chat is Alpha. It is a bundled webhook-based direct-message channel with strong setup/security docs, token verification, incoming/outgoing webhook behavior, allowlist policy, outbound URL media, multi-account path guards, and webhook troubleshooting. Source includes a real route-registration integration test, webhook handler tests, security audit, client, setup, and runtime modules. It stays Alpha because inbound attachments and group/channel support remain open or partially scoped, and archive evidence shows invalid-token, ACK, timeout, and group-route review churn.

## Category Scope

- Synology Chat incoming/outgoing webhook setup, token/incoming URL config, env vars, setup surface, and multi-account route config.
- Webhook token verification, DM policy, allowed user IDs, pairing, rate limiting, invalid-token lockout, session keys, direct-message inbound context, and webhook ACK semantics.
- Outbound text and URL media delivery, private-network SSRF guards, security audit, setup/status, and troubleshooting.

## Features

- Synology Chat incoming/outgoing webhook setup: Synology Chat incoming/outgoing webhook setup, token/incoming URL config, env vars, setup surface, and multi-account route config
- Webhook token verification: Webhook token verification, DM policy, allowed user IDs, pairing, rate limiting, invalid-token lockout, session keys, direct-message inbound context, and webhook ACK semantics
- Outbound text: Outbound text and URL media delivery, private-network SSRF guards, security audit, setup/status, and troubleshooting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: docs/source cover setup, token precedence, allowlist/open/disabled policy, outbound delivery, URL media, multi-account route uniqueness, security notes, troubleshooting, and route registration integration.
- Negative signals: no live Synology NAS/Chat e2e scenario was found; inbound attachments and group/channel behavior are still not first-class.
- Integration gaps: real Synology outgoing webhook, incoming webhook reply, invalid-token lockout, multi-account routes, URL media send, and direct-message pairing are not proven in a recurring NAS-backed scenario.

## Quality Score

- Score: `Alpha (67%)`
- Gitcrawl reports: current results include `#53441/#53439` webhook HEAD/ACK compatibility, `#82585` trigger word replacement, `#26926` attachment support, `#57824` invalid-token throttling and ACP image forwarding, and `#69603` SSRF guard for `sendFileUrl`.
- Discrawl reports: 2026-04-26 archive review kept attachment support open because inbound webhooks are text-only; 2026-03-25/30 archive messages discussed invalid-token throttling, webhook ACK, and group/channel response-code behavior.
- Good qualities: token validation fails closed, docs define token source precedence, source rejects ambiguous inherited multi-account paths, security audit warns about mutable username matching, and outbound URL delivery has private-network guards.
- Bad qualities: inbound media is absent, group/channel support is not the current documented scope, and webhook ACK/status semantics have generated several compatibility fixes.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No recurring real Synology NAS/Chat proof is checked in.
- Inbound attachments remain an open feature request; outbound media is URL-based only.
- Group/channel support is not part of the current stable docs, and prior attempts required careful ACK/policy handling.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/synology-chat.md` lines 9-18 describe bundled direct-message webhook channel status.
- `/Users/kevinlin/code/openclaw/docs/channels/synology-chat.md` lines 29-77 document quick setup, incoming/outgoing webhook creation, token source precedence, minimal config, and env vars.
- `/Users/kevinlin/code/openclaw/docs/channels/synology-chat.md` lines 92-117 document DM policy, allowlists, pairing, outbound targets, and URL media delivery.
- `/Users/kevinlin/code/openclaw/docs/channels/synology-chat.md` lines 119-181 document multi-account routing, security notes, invalid-token/rate-limit behavior, and troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/synology-chat.md` declares `@openclaw/synology-chat` and the `synology-chat` channel surface.

### Source

- `/Users/kevinlin/code/openclaw/extensions/synology-chat/openclaw.plugin.json` declares plugin id `synology-chat` and channel `synology-chat`.
- `/Users/kevinlin/code/openclaw/extensions/synology-chat/package.json` names the package `@openclaw/synology-chat`.
- `/Users/kevinlin/code/openclaw/extensions/synology-chat/src/gateway-runtime.ts`, `webhook-handler.ts`, `inbound-event.ts`, `inbound-context.ts`, and `session-key.ts` implement webhook route registration, inbound event handling, context, and session keys.
- `/Users/kevinlin/code/openclaw/extensions/synology-chat/src/channel.ts`, `client.ts`, `security.ts`, `security-audit.ts`, `accounts.ts`, and `config-schema.ts` implement channel/outbound behavior, security, accounts, and config.
- `/Users/kevinlin/code/openclaw/extensions/synology-chat/src/setup-surface.ts` implements setup behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/synology-chat/src/channel.integration.test.ts` registers a real webhook handler against resolved account config and enforces allowlist behavior with local HTTP test utilities.
- No committed real Synology NAS/Chat e2e or QA scenario was found under `/Users/kevinlin/code/openclaw/qa`.

### Unit tests

- Synology Chat has 7 focused tests, including `approval-auth.test.ts`, `channel.integration.test.ts`, `channel.test.ts`, `client.test.ts`, `core.test.ts`, `security-audit.test.ts`, and `webhook-handler.test.ts`.
- `/Users/kevinlin/code/openclaw/extensions/synology-chat/src/webhook-handler.test.ts` covers token sources, authorization, rate limits, ACK behavior, sanitization, trigger stripping, and async delivery.

### Gitcrawl queries

Query: `synology-chat`

Results:

- `#53441` open PR: `fix(synology-chat): handle HEAD probe and return 200 on webhook ACK`.
- `#82585` open PR: `feat(synology-chat): add configurable triggerWord to replace payload-based stripping`.
- `#53439` open issue: webhook POST ACK and HEAD probe compatibility.
- `#26926` open issue: Synology Chat attachment support.
- `#57824` open PR: ACP image forwarding and Synology invalid-token throttling.
- `#69603` open PR: SSRF guard for Synology Chat `sendFileUrl`.

Query: `Synology Chat webhook token allowlist incoming`

Results:

- The simple `synology-chat` query returned more focused current results than the longer query.

### Discrawl queries

Query: `Synology Chat attachment support`

Results:

- 2026-04-26 archive review kept issue `#26926` open because current main still models/parses Synology Chat inbound webhooks as text messages and outbound URL media does not satisfy inbound attachment support.

Query: `Synology Chat webhook ACK`

Results:

- 2026-03-25 review on PR `#54099` warned that a disabled group-policy branch returned HTTP 403 rather than silent ACK, which could cause Synology webhook retries.
- 2026-03-02 archive comment on PR `#26635` recorded landed webhook hardening/compatibility, 204 ACK, cfg-based outbound resolution, and Chat API user-id reply routing.
