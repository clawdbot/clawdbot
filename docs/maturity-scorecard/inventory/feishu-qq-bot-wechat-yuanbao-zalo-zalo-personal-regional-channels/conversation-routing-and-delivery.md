---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels - Conversation Routing and Delivery Maturity Note

## Summary

This note is the active normalized maturity note for `Conversation Routing and Delivery` on the `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` channel surface. It consolidates prior channel-specific evidence notes while preserving those older notes in the inventory directory for historical detail.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Bot Channels`, `Personal Account Channels`
- Score carry-forward: conservative minimum of merged source category scores.

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
- WeChat/Weixin personal messaging: WeChat/Weixin personal messaging through external package @tencent-weixin/openclaw-weixin
- Plugin install: Plugin install, enablement, compatibility, QR login, saved account tokens, and channel id openclaw-weixin
- Direct-message pairing: Direct-message pairing and per-account session isolation
- Core-side catalog metadata: Core-side catalog metadata, aliases, install plans, plugin trust markers, status/repair hints, docs redirects, and channel discovery
- External sidecar/helper process behavior: External sidecar/helper process behavior and stale process cleanup protections
- zalouser channel plugin: zalouser channel plugin for Zalo Personal Account automation via native zca-js
- QR login: QR login, saved profiles, multi-account/profile selection, and gateway-local runtime
- DM pairing: DM pairing, group policy, group gating, directory peers, and sender/session routing
- Message send: Message send, image/link/document media, reactions, status, friends/groups/me tools, and text style normalization
- Doctor/status checks for runtime availability: Doctor/status checks for runtime availability and profile/session health
- Explicit unofficial-account risk: Explicit unofficial-account risk and operator safeguards
- QQ Open Platform AppID/AppSecret setup and: Covers QQ Open Platform AppID/AppSecret setup and default-account env/config handling behavior.
- C2C private chat: Covers C2C private chat, group messages, guild channel messages, and target parsing behavior.
- Group activation: Covers Group activation, mention gates, group history, tool policies, and sender allowlists behavior.
- Inbound and outbound rich media including: Covers Inbound and outbound rich media including images, voice, video, files, STT/TTS, and native voice sends behavior.
- Slash commands: Covers Slash commands, approval buttons, reminder/channel tools, and framework command registration behavior.
- Multi-account gateway connections: Covers Multi-account gateway connections, token cache, credential backups, diagnostics, and reconnect behavior behavior.
- Tencent Yuanbao external channel `openclaw-plugin-yuanbao`: Evidence scope for Tencent Yuanbao external channel `openclaw-plugin-yuanbao`.
- AppKey/AppSecret setup: Covers AppKey/AppSecret setup, login wizard, multi-account config, and default account routing behavior.
- DMs: Covers DMs, groups, mention requirements, reply-to mode, group history context, slash-command menus, and fallback replies behavior.
- Outbound queue strategy: Covers Outbound queue strategy, merge-text tuning, max chars, media caps, overflow behavior, and block-level streaming behavior.
- Core-side official external catalog: Covers Core-side official external catalog, install metadata, aliases, wizard blurbs, and channel catalog contracts behavior.
- Zalo Bot Creator / Marketplace bot: Covers Zalo Bot Creator / Marketplace bot DM channel behavior.
- Long-polling default mode and optional HTTPS: Covers Long-polling default mode and optional HTTPS webhook mode behavior.
- Bot token: Covers Bot token, token-file, multi-account, DM pairing, and allowlist behavior behavior.
- Group policy schema and fail-closed group: Covers Group policy schema and fail-closed group gates even where Marketplace groups are not usable behavior.
- Text: Covers Text, media placeholders, outbound chunking, replay dedupe, rate limiting, webhook secrets, and proxy support behavior.
- Status probes and troubleshooting for token/config/webhook problems: Evidence scope for Status probes and troubleshooting for token/config/webhook problems.
- `zalouser` channel plugin for Zalo Personal: Covers `zalouser` channel plugin for Zalo Personal Account automation via native `zca-js` behavior.
- QR login: Covers QR login, saved profiles, multi-account/profile selection, and gateway-local runtime behavior.
- DM pairing: Covers DM pairing, group policy, group gating, directory peers, and sender/session routing behavior.
- Message send: Covers Message send, image/link/document media, reactions, status, friends/groups/me tools, and text style normalization behavior.
- Doctor/status checks for runtime availability and: Covers Doctor/status checks for runtime availability and profile/session health behavior.
- Explicit unofficial-account risk and operator safeguards: Evidence scope for Explicit unofficial-account risk and operator safeguards.

## Features

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

## Evidence

- Historical source notes remain in this surface inventory directory and were used as source evidence for the normalized taxonomy row.
