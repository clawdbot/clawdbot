---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Access and Identity Maturity Note

## Summary

This note is the active normalized maturity note for `Access and Identity` on the `Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat` channel surface. It consolidates prior channel-specific evidence notes while preserving those older notes in the inventory directory for historical detail.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Workspace Chat`, `Webhook Messaging`, `IRC Chat`, `Decentralized Messaging`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Mattermost bot account setup: Mattermost bot account setup, bot token/base URL configuration, multi-account config, and plugin packaging
- WebSocket inbound monitoring: WebSocket inbound monitoring, DM/channel routing, access control, pairing, mention gating, and session threading
- Outbound delivery: Outbound delivery, draft preview streaming, reactions, interactive buttons, slash commands, directory lookup, diagnostics, and doctor behavior
- LINE Messaging API webhook setup: LINE Messaging API webhook setup, channel access token/channel secret handling, multi-account routing, and plugin install
- Signed inbound webhook events: Signed inbound webhook events, immediate acknowledgement, DM/group authorization, pairing, group keys, message context, redelivery dedupe, and durable reply delivery
- Rich LINE payloads: Rich LINE payloads, quick replies, locations, Flex/template cards, outbound image/audio/video media, rich menus, status, and troubleshooting
- Nextcloud Talk bot installation: Nextcloud Talk bot installation, shared secret/API credentials, webhook route, room settings, file-backed secrets, and plugin runtime setup
- Webhook ingress: Webhook ingress, signature/secret validation, room-vs-DM lookup, DM/group policy, pairing, mention gating, replay protection, and room metadata
- Outbound markdown/text: Outbound markdown/text, URL media fallback, reactions/message actions, threading, status, doctor, setup, and troubleshooting
- Synology Chat incoming/outgoing webhook setup: Synology Chat incoming/outgoing webhook setup, token/incoming URL config, env vars, setup surface, and multi-account route config
- Webhook token verification: Webhook token verification, DM policy, allowed user IDs, pairing, rate limiting, invalid-token lockout, session keys, direct-message inbound context, and webhook ACK semantics
- Outbound text: Outbound text and URL media delivery, private-network SSRF guards, security audit, setup/status, and troubleshooting
- IRC server/nick/TLS/NickServ setup: IRC server/nick/TLS/NickServ setup, env/config loading, account resolution, and plugin runtime setup
- Raw IRC receive/send: Raw IRC receive/send, direct messages, channel messages, sender identity normalization, control-character handling, access policy, mention gating, and tools-by-sender policy
- Probe/status: Probe/status, outbound text normalization, reconnect/monitor lifecycle, and security defaults around direct IRC egress
- Twitch bot account setup: Twitch bot account setup, OAuth access/refresh tokens, client ID/secret, channel join config, multi-account config, and package/bundled install behavior
- Twitch IRC monitor/client lifecycle: Twitch IRC monitor/client lifecycle, token refresh, status/probe, access control by user ID/roles, requireMention, and outbound chat delivery
- Message tool send action: Message tool send action, moderation-oriented action surface, safety/ops, and troubleshooting
- Nostr key setup: Nostr key setup, relay configuration, profile metadata, private key handling, plugin install, and setup status
- NIP-04 encrypted DM receive/send: NIP-04 encrypted DM receive/send, event signature verification, sender policy, relay bus, duplicate/seen tracking, local relay testing, and state storage
- Profile import/publish: Profile import/publish, relay URL safety, metrics, session routing, and limitations around media and newer encrypted DM protocols
- Tlon/Urbit ship URL/code setup: Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior
- Urbit API auth/session: Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers
- Rich text conversion: Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting
- Synology Chat incoming/outgoing webhook setup: Covers Synology Chat incoming/outgoing webhook setup, token/incoming URL config, env vars, setup surface, and multi-account route config behavior.
- Webhook token verification: Covers Webhook token verification, DM policy, allowed user IDs, pairing, rate limiting, invalid-token lockout, session keys, direct-message inbound context, and webhook ACK semantics behavior.
- Outbound text and URL media delivery: Covers Outbound text and URL media delivery, private-network SSRF guards, security audit, setup/status, and troubleshooting behavior.
- Tlon/Urbit ship URL/code setup: Covers Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior behavior.
- Urbit API auth/session: Covers Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers behavior.
- Rich text conversion: Covers Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting behavior.

## Features

- Access and Identity: Evidence scope for Access and Identity.

## Evidence

- Historical source notes remain in this surface inventory directory and were used as source evidence for the normalized taxonomy row.
