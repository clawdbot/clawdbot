---
title: "Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (62%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (62%)`
- LTS Features: `0/4`

## Summary

This report promotes the archived `mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat` maturity evidence from `/Users/kevinlin/tmp/maturity/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                  | LTS | Coverage      | Quality       | Completeness  | Features to evaluate              |
| ------------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | --------------------------------- |
| [Channel Setup and Operations](channel-setup-and-operations.md)           | ❌  | `Alpha (62%)` | `Alpha (58%)` | `Alpha (62%)` | Channel Setup and Operations      |
| [Access and Identity](access-and-identity.md)                             | ❌  | `Alpha (62%)` | `Alpha (58%)` | `Alpha (62%)` | Access and Identity               |
| [Conversation Routing and Delivery](conversation-routing-and-delivery.md) | ❌  | `Alpha (62%)` | `Alpha (58%)` | `Alpha (62%)` | Conversation Routing and Delivery |
| [Media and Rich Content](media-and-rich-content.md)                       | ❌  | `Alpha (62%)` | `Alpha (58%)` | `Alpha (62%)` | Media and Rich Content            |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Channel Setup and Operations

Search anchors: mattermost, line, irc, nextcloud talk, nostr, twitch, tlon, synology chat channel setup and operations, channel setup and operations.

Category note: [Channel Setup and Operations](channel-setup-and-operations.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- Channel Setup and Operations: Evidence scope for Channel Setup and Operations.

Primary docs:

### 2. Access and Identity

Search anchors: mattermost, line, irc, nextcloud talk, nostr, twitch, tlon, synology chat access and identity, access and identity.

Category note: [Access and Identity](access-and-identity.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- Access and Identity: Evidence scope for Access and Identity.

Primary docs:

### 3. Conversation Routing and Delivery

Search anchors: mattermost, line, irc, nextcloud talk, nostr, twitch, tlon, synology chat conversation routing and delivery, conversation routing and delivery.

Category note: [Conversation Routing and Delivery](conversation-routing-and-delivery.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

Primary docs:

### 4. Media and Rich Content

Search anchors: mattermost, line, irc, nextcloud talk, nostr, twitch, tlon, synology chat media and rich content, media and rich content.

Category note: [Media and Rich Content](media-and-rich-content.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- Media and Rich Content: Evidence scope for Media and Rich Content.

Primary docs:

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat`.
