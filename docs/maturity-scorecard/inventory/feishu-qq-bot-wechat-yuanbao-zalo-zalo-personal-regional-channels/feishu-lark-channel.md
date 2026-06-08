---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Bot Channels Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Bot Channels Maturity Note

## Summary

Feishu/Lark is the strongest regional-channel component in this surface. The docs describe the channel as production-ready for bot DMs and group chats, source covers WebSocket and webhook startup, QR/manual setup, DM and group access policy, card actions, dynamic agents, document/wiki/drive tools, media, streaming cards, reactions, comments, and thread bindings, and the extension has broad focused tests. The main limiter is current lived quality: gitcrawl and discrawl both show recent Feishu delivery/status/tool-injection regressions and onboarding/support friction.

## Category Scope

Included in this category:

- Feishu/Lark bot channel setup: Feishu/Lark bot channel setup through manual App ID/App Secret or QR app registration
- WebSocket default mode: WebSocket default mode and optional webhook mode
- DM pairing: DM pairing, allowlists, group policy, mention gates, per-group overrides, and sender restrictions
- Message delivery: Message delivery, replies, streaming cards, reactions, comments, bot menus, and card actions
- Feishu document: Feishu document, wiki, drive, bitable, and dynamic-agent tools
- Multi-account credential handling: Multi-account credential handling and troubleshooting for regional Feishu/Lark deployments
- QQ Open Platform AppID/AppSecret setup: QQ Open Platform AppID/AppSecret setup and default-account env/config handling
- C2C private chat: C2C private chat, group messages, guild channel messages, and target parsing
- Group activation: Group activation, mention gates, group history, tool policies, and sender allowlists
- Rich media messages: Inbound and outbound rich media including images, voice, video, files, STT/TTS, and native voice sends
- Slash commands: Slash commands, approval buttons, reminder/channel tools, and framework command registration
- Multi-account gateway connections: Multi-account gateway connections, token cache, credential backups, diagnostics, and reconnect behavior
- Tencent Yuanbao external channel: Tencent Yuanbao external channel openclaw-plugin-yuanbao
- AppKey/AppSecret setup: AppKey/AppSecret setup, login wizard, multi-account config, and default account routing
- DMs: DMs, groups, mention requirements, reply-to mode, group history context, slash-command menus, and fallback replies
- Outbound queue strategy: Outbound queue strategy, merge-text tuning, max chars, media caps, overflow behavior, and block-level streaming
- Core-side official external catalog: Core-side official external catalog, install metadata, aliases, wizard blurbs, and channel catalog contracts
- Zalo Bot Creator / Marketplace bot: Zalo Bot Creator / Marketplace bot DM channel
- Long-polling default mode: Long-polling default mode and optional HTTPS webhook mode
- Bot token: Bot token, token-file, multi-account, DM pairing, and allowlist behavior
- Group policy schema: Group policy schema and fail-closed group gates even where Marketplace groups are not usable
- Text: Text, media placeholders, outbound chunking, replay dedupe, rate limiting, webhook secrets, and proxy support
- Status probes: Status probes and troubleshooting for token/config/webhook problems

## Features

- Feishu/Lark bot channel setup: Feishu/Lark bot channel setup through manual App ID/App Secret or QR app registration
- WebSocket default mode: WebSocket default mode and optional webhook mode
- DM pairing: DM pairing, allowlists, group policy, mention gates, per-group overrides, and sender restrictions
- Message delivery: Message delivery, replies, streaming cards, reactions, comments, bot menus, and card actions
- Feishu document: Feishu document, wiki, drive, bitable, and dynamic-agent tools
- Multi-account credential handling: Multi-account credential handling and troubleshooting for regional Feishu/Lark deployments
- QQ Open Platform AppID/AppSecret setup: QQ Open Platform AppID/AppSecret setup and default-account env/config handling
- C2C private chat: C2C private chat, group messages, guild channel messages, and target parsing
- Group activation: Group activation, mention gates, group history, tool policies, and sender allowlists
- Rich media messages: Inbound and outbound rich media including images, voice, video, files, STT/TTS, and native voice sends
- Slash commands: Slash commands, approval buttons, reminder/channel tools, and framework command registration
- Multi-account gateway connections: Multi-account gateway connections, token cache, credential backups, diagnostics, and reconnect behavior
- Tencent Yuanbao external channel: Tencent Yuanbao external channel openclaw-plugin-yuanbao
- AppKey/AppSecret setup: AppKey/AppSecret setup, login wizard, multi-account config, and default account routing
- DMs: DMs, groups, mention requirements, reply-to mode, group history context, slash-command menus, and fallback replies
- Outbound queue strategy: Outbound queue strategy, merge-text tuning, max chars, media caps, overflow behavior, and block-level streaming
- Core-side official external catalog: Core-side official external catalog, install metadata, aliases, wizard blurbs, and channel catalog contracts
- Zalo Bot Creator / Marketplace bot: Zalo Bot Creator / Marketplace bot DM channel
- Long-polling default mode: Long-polling default mode and optional HTTPS webhook mode
- Bot token: Bot token, token-file, multi-account, DM pairing, and allowlist behavior
- Group policy schema: Group policy schema and fail-closed group gates even where Marketplace groups are not usable
- Text: Text, media placeholders, outbound chunking, replay dedupe, rate limiting, webhook secrets, and proxy support
- Status probes: Status probes and troubleshooting for token/config/webhook problems

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: source-backed channel behavior spans setup, inbound/outbound turns, cards, reactions, comments, tools, dynamic agents, streaming, policy, and multi-account paths; Feishu has a dedicated extension test project and lifecycle/webhook tests.
- Negative signals: no current live Feishu platform scenario was found that starts from a fresh app, completes setup, publishes/approves platform permissions, exercises DMs, groups, cards, media, tools, and reconnect behavior against Feishu/Lark itself.
- Integration gaps: repeatable public scenario proof is missing for QR setup fallback, platform approval/scopes, topic replies, card callbacks, tool injection, and delivery status across WebSocket and webhook modes.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the component. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: broad `Feishu` search returned open reports for tool-contract propagation, configured-and-connected status omission, delivered-false slash commands, cron delivery preview, DM tool injection, reaction ID normalization, and streaming fallback.
- Discrawl reports: Feishu search returned maintainer discussion from 2026-05-28 around `/compact` delivery disappearing on Feishu/WebChat, gateway restart continuation routing, recent Feishu/message-delivery reports, an 8-agent/7-Feishu-channel stress issue, and a 2026-05-25 user complaint linking a Feishu gateway timeout report.
- Good qualities: the implementation has coherent source boundaries for setup, policy, account resolution, card actions, thread binding, tool routing, and security handling; docs call out manual fallback, platform scopes, group policy, and secret rotation.
- Bad qualities: recent issue/archive evidence shows status visibility, delivery, command, tool injection, and setup rough edges; Feishu also has enough platform approval and domestic/Lark split behavior that public support can be fragile without a maintained runbook.
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

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Feishu/Lark bot channel setup, WebSocket default mode, DM pairing, Message delivery, Feishu document, Multi-account credential handling, QQ Open Platform AppID/AppSecret setup, C2C private chat, Group activation, Rich media messages, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, Zalo Bot Creator / Marketplace bot, Long-polling default mode, Bot token, Group policy schema, Text, Status probes.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a current live Feishu/Lark scorecard that runs setup, platform approval, WebSocket delivery, webhook delivery, DM pairing, group mentions, card callbacks, media, and tool calls.
- Keep the Feishu docs aligned with current setup behavior for QR app registration, manual fallback, Lark versus Feishu platform terminology, and required scopes.
- Close or explicitly document the recent delivery/status/tool-injection rough edges visible in gitcrawl and discrawl.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/feishu.md` states Feishu/Lark is production-ready for bot DMs and group chats, with WebSocket as default and webhook mode optional.
- `/Users/kevinlin/code/openclaw/docs/channels/feishu.md` documents `openclaw channels login --channel feishu`, manual App ID/App Secret setup, QR setup fallback, gateway restart, DM policy, group policy, mention requirements, sender restrictions, common commands, required platform scopes, troubleshooting, app secret rotation, and multi-account configuration.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/feishu.md` identifies package `@openclaw/feishu`, install route `npm; ClawHub`, and surface `channels: feishu; contracts: tools; skills`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/feishu/src/channel.ts`, `channel.runtime.ts`, `monitor.ts`, `monitor.startup.ts`, `monitor.transport.ts`, and `monitor.webhook-security.test.ts` anchor channel registration, startup, transport, and webhook security behavior.
- `/Users/kevinlin/code/openclaw/extensions/feishu/src/setup-surface.ts`, `setup-core.ts`, `app-registration.ts`, `secret-input.ts`, `accounts.ts`, and `config-schema.ts` implement setup, credential input, app registration, accounts, and config validation.
- `/Users/kevinlin/code/openclaw/extensions/feishu/src/policy.ts`, `conversation-id.ts`, `session-conversation.ts`, `thread-bindings.ts`, `reply-dispatcher.ts`, and `send-target.ts` implement access, conversation/session binding, thread routing, and reply targeting.
- `/Users/kevinlin/code/openclaw/extensions/feishu/src/card-action.ts`, `card-ux-approval.ts`, `card-ux-launcher.ts`, `streaming-card.ts`, `reactions.ts`, `comment-handler.ts`, `directory.ts`, `docx.ts`, `bitable.ts`, `perm.ts`, `pins.ts`, and `dynamic-agent.ts` cover richer Feishu surfaces.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/vitest/vitest.extension-feishu.config.ts` defines the dedicated Feishu test project.
- `/Users/kevinlin/code/openclaw/extensions/feishu/src/monitor.webhook-e2e.test.ts`, `monitor.lifecycle.test.ts`, `monitor.bot-menu.test.ts`, `monitor.reaction.test.ts`, `monitor.comment.test.ts`, `reply-dispatcher.test.ts`, `subagent-hooks.test.ts`, `thread-bindings.test.ts`, and lifecycle test-support files exercise transport and channel-flow behavior.
- No current live Feishu/Lark platform scenario was found that proves the whole setup-to-message-to-tool workflow against an actual Feishu/Lark tenant.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/feishu/src/config-schema.test.ts`, `setup-surface.test.ts`, `accounts.test.ts`, `policy.test.ts`, `conversation-id.test.ts`, `send.test.ts`, `outbound.test.ts`, `media.test.ts`, `tool-result.test.ts`, `streaming-card.test.ts`, `bot.card-action.test.ts`, `approval-auth.test.ts`, `security-audit.test.ts`, and document/wiki/drive tests cover focused behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Feishu webhook encrypt key card action group topic reply" --json --limit 6`
- `gitcrawl search openclaw/openclaw --query "Feishu" --json --limit 8`

Results:

- The feature-specific query returned no hits.
- The broad Feishu query returned open PR/issue hits including `#77882` bitable tools gated by tools config, `#77982` Lark tool contracts not propagated, `#77709` `openclaw status --deep` omitting configured/connected Feishu, `#77653` reaction message ID normalization, `#82356` delivered-false slash commands, `#77712` cron delivery preview unsupported-channel copy, `#84095` Feishu tools not injected into DM sessions, and `#74808` searchable streaming fallback.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 6 "Feishu QR setup manual App ID App Secret"`
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "Feishu"`

Results:

- The QR/manual setup query returned PR `#65680` describing streamlined Feishu onboarding because manual App ID/App Secret setup was error-prone.
- The broad Feishu query returned 2026-05-28 maintainer discussion of `/compact` delivery disappearing on Feishu/WebChat, Clawsweeper reports involving Feishu delivery and configured-channel issues, 8-agent/7-Feishu-channel stress, and a user report linking a Feishu gateway timeout issue.
