# Changelog

## 2026.1.27-beta.1

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.23

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.22

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.21

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.20

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.17-1

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.17

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.16

### Changes
- Version alignment with core Moltbot release numbers.

## 2026.1.15

### Features
- Bot Framework gateway monitor (Express + JWT auth) with configurable webhook path/port and `/api/messages` fallback.
- Onboarding flow for Azure Bot credentials (config + env var detection) and DM policy setup.
- Channel capabilities: DMs, group chats, channels, threads, media, polls, and `teams` alias.
- DM pairing/allowlist enforcement plus group policies with per-team/channel overrides and mention gating.
- Inbound debounce + history context for room/group chats; mention tag stripping and timestamp parsing.
- Proactive messaging via stored conversation references (file store with TTL/size pruning).
- Outbound text/media send with markdown chunking, 4k limit, split/inline media handling.
- Adaptive Card polls: build cards, parse votes, and persist poll state with vote tracking.
- Attachment processing: placeholders + HTML summaries, inline image extraction (including data: URLs).
- Media downloads with host allowlist, auth scope fallback, and Graph hostedContents/attachments fallback.
- Retry/backoff on transient/throttled sends with classified errors + helpful hints.
