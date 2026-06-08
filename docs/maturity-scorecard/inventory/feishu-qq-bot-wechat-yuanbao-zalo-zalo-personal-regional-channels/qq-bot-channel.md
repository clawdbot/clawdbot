---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - QQ Bot Channel Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - QQ Bot Channel Maturity Note

## Summary

QQ Bot is a substantial official-channel implementation with docs for credential setup, C2C, groups, guild channels, media, voice, commands, targets, multi-account behavior, and SecretRef credentials. Source is broad and tests cover gateway connection, inbound/outbound processing, command auth, media, access, config, and approval behavior. The channel still has active quality drag from open issues around target normalization, storage paths, reconnect/session preservation, stale media cleanup, credential isolation, and local-model timeout behavior.

## Category Scope

- QQ Open Platform AppID/AppSecret setup and default-account env/config handling.
- C2C private chat, group messages, guild channel messages, and target parsing.
- Group activation, mention gates, group history, tool policies, and sender allowlists.
- Inbound and outbound rich media including images, voice, video, files, STT/TTS, and native voice sends.
- Slash commands, approval buttons, reminder/channel tools, and framework command registration.
- Multi-account gateway connections, token cache, credential backups, diagnostics, and reconnect behavior.

## Features

- QQ Open Platform AppID/AppSecret setup: QQ Open Platform AppID/AppSecret setup and default-account env/config handling
- C2C private chat: C2C private chat, group messages, guild channel messages, and target parsing
- Group activation: Group activation, mention gates, group history, tool policies, and sender allowlists
- Rich media messages: Inbound and outbound rich media including images, voice, video, files, STT/TTS, and native voice sends
- Slash commands: Slash commands, approval buttons, reminder/channel tools, and framework command registration
- Multi-account gateway connections: Multi-account gateway connections, token cache, credential backups, diagnostics, and reconnect behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: the QQ Bot extension has broad focused tests across connection, inbound pipeline, group gates, outbound dispatch, command auth, media handling, setup, config, credentials, approval behavior, and channel-message adaptation.
- Negative signals: no current live QQ Open Platform scenario was found that creates a bot, starts the gateway WebSocket, exercises C2C, group, guild, slash commands, approvals, media, voice, reconnect/resume, and multi-account behavior against the upstream service.
- Integration gaps: live proof is thin for upstream token refresh, official gateway reconnect semantics, large media, group/guild routing, slow local-model replies, and real QQ client UX.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the component. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: broad `QQBot` search returned open reports around cron target normalization, path handling, actionable error messages, delivery target inconsistency, local model timeout/network interruption, credential backup isolation, reconnect resume, and stale media cleanup.
- Discrawl reports: QQBot search returned maintainer release discussion about QQBot timeout fixes, partial-streaming progress delivery, official install confusion that exposed an unexpected `qqbot` tool, and release-window channel/plugin regression concerns.
- Good qualities: source separation is strong, with engine/bridge layers for gateway, commands, messaging, media, config, access, approval, setup, and tools; docs are explicit about account-specific OpenIDs, target formats, SecretRef handling, group policy, and unsupported reactions/threads.
- Bad qualities: support and issue archives show recurring routing, timeout, path, storage, and upgrade confusion; the QQ Bot upstream API has multiple chat surfaces and account-specific IDs, which raises operator error risk.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test presence or absence; these are Coverage inputs only.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for QQ Open Platform AppID/AppSecret setup, C2C private chat, Group activation, Rich media messages, Slash commands, Multi-account gateway connections.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live QQ Bot scenario that covers app registration, C2C, group, guild channel, slash command, approval, rich media, voice, timeout, reconnect/resume, and multi-account behavior.
- Continue tightening operator-facing diagnostics for target format, AppID/AppSecret setup, SecretRef, storage paths, local model timeouts, and upstream gateway reconnect states.
- Clarify stale media cleanup and credential backup isolation in docs or runtime status.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/qqbot.md` describes QQ Bot as a downloadable plugin using the official QQ Bot WebSocket gateway, supporting C2C private chat, group @messages, guild channel messages, and rich media, while stating reactions and threads are not supported.
- `/Users/kevinlin/code/openclaw/docs/channels/qqbot.md` documents install, Open Platform setup, AppID/AppSecret token format, SecretRef, multi-account setup, group policy, voice STT/TTS, target formats, and slash commands.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/qqbot.md` identifies package `@openclaw/qqbot`, install route `npm; ClawHub`, and surface `channels: qqbot; contracts: tools; skills`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/qqbot/src/channel.ts`, `channel.setup.ts`, `config-schema.ts`, `secret-contract.ts`, `exec-approvals.ts`, and `qqbot-test-support.ts` anchor the channel entry, setup, config, secret, and approval surfaces.
- `/Users/kevinlin/code/openclaw/extensions/qqbot/src/engine/gateway/*` implements WebSocket connection, event dispatch, inbound stages, queueing, reconnect, typing keepalive, response timeout, and outbound dispatch.
- `/Users/kevinlin/code/openclaw/extensions/qqbot/src/engine/messaging/*`, `engine/api/*`, `engine/commands/*`, `engine/group/*`, `engine/access/*`, `engine/config/*`, and `engine/tools/*` implement target parsing, media, QQ API calls, slash commands, group policy, allowlists, setup, reminder/channel tools, and formatting.
- `/Users/kevinlin/code/openclaw/extensions/qqbot/src/bridge/*` adapts the engine to plugin runtime, setup, channel entry, command registration, approval runtime, and SDK surface.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qqbot/src/channel.message-adapter.test.ts`, `exec-approvals.test.ts`, `bridge/commands/framework-registration.test.ts`, `bridge/commands/framework-context-adapter.test.ts`, `engine/gateway/outbound-dispatch.test.ts`, `engine/gateway/inbound-pipeline.self-echo.test.ts`, `engine/gateway/interaction-handler.test.ts`, `engine/commands/slash-command-handler.test.ts`, and `engine/api/media-chunked.test.ts` exercise channel-flow behavior through the plugin surface.
- No current live QQ Open Platform WebSocket scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/qqbot/src/config.test.ts`, `secret-contract.test.ts`, `engine/config/*.test.ts`, `engine/access/*.test.ts`, `engine/group/*.test.ts`, `engine/gateway/stages/*.test.ts`, `engine/utils/*.test.ts`, `engine/api/*.test.ts`, `engine/approval/index.test.ts`, and `engine/ref/*.test.ts` cover focused logic for configuration, credentials, matching, groups, pipeline stages, media, token/API behavior, approvals, and references.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "QQBot media OPENCLAW_HOME slash command approval timeout" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "QQBot" --json --limit 8`

Results:

- The feature-specific query returned no hits.
- The broad QQBot query returned open hits including `#78916` cron delivery target normalization, `#39461` path/data-dir issue, `#65868` actionable error-message request, `#78893` cron target inconsistency, `#87262` local-model/network interruption, `#84314` credential backup isolation, `#78898` reconnect session preservation, and `#78895` stale media cleanup.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 6 "QQBot OPENCLAW_HOME media slash command approval"`
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "QQBot"`

Results:

- The feature-specific query returned no results.
- The broad QQBot query returned 2026-05-27 Clawsweeper mention of a qqbot/ollama issue, 2026-05-25 maintainer update citing a QQBot timeout fix, 2026-05-22 review request for QQBot partial-streaming progress delivery, and 2026-05-14 release-window notes about an unexpected `qqbot` tool after official install.
