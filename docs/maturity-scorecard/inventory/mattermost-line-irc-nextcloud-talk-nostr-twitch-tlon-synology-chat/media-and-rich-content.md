---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat - Media and Rich Content Maturity Note

## Summary

This note is the active normalized maturity note for `Media and Rich Content` on the `Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat` channel surface. It consolidates prior channel-specific evidence notes while preserving those older notes in the inventory directory for historical detail.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Webhook Messaging`, `Decentralized Messaging`
- Score carry-forward: conservative minimum of merged source category scores.

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
- Nostr key setup: Nostr key setup, relay configuration, profile metadata, private key handling, plugin install, and setup status
- NIP-04 encrypted DM receive/send: NIP-04 encrypted DM receive/send, event signature verification, sender policy, relay bus, duplicate/seen tracking, local relay testing, and state storage
- Profile import/publish: Profile import/publish, relay URL safety, metrics, session routing, and limitations around media and newer encrypted DM protocols
- Tlon/Urbit ship URL/code setup: Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior
- Urbit API auth/session: Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers
- Rich text conversion: Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting
- Tlon/Urbit ship URL/code setup: Covers Tlon/Urbit ship URL/code setup, private network opt-in, group channel config, owner ship, allowlists, auto-accept, and setup/doctor behavior behavior.
- Urbit API auth/session: Covers Urbit API auth/session, SSE monitor, DM/group discovery, group mention handling, thread replies, approvals, processed message tracking, and settings helpers behavior.
- Rich text conversion: Covers Rich text conversion, image upload through Tlon storage/Memex, delivery targets, bundled Tlon skill, security, and troubleshooting behavior.

## Features

- Media and Rich Content: Evidence scope for Media and Rich Content.

## Evidence

- Historical source notes remain in this surface inventory directory and were used as source evidence for the normalized taxonomy row.
