---
title: "Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Experimental (43%)`
- Quality: `Experimental (47%)`
- Completeness: `Experimental (43%)`
- LTS Features: `0/4`

## Summary

This report promotes the archived `feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels` maturity evidence from `/Users/kevinlin/tmp/maturity/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                          | LTS | Coverage             | Quality              | Completeness         | Features to evaluate                                                                                                                                                             |
| --------------------------------------------------------------------------------- | --- | -------------------- | -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Setup and Operations](shared-regional-channel-catalog-install-status.md) | ❌  | `Experimental (42%)` | `Experimental (44%)` | `Experimental (42%)` | Docs channel index, Official external channel catalog entries, Core channel-plugin catalog, Channel setup wizard, Missing-plugin, Cross-channel ingress/access/refactor concerns |
| [Access and Identity](access-and-identity.md)                                     | ❌  | `Experimental (42%)` | `Experimental (44%)` | `Experimental (42%)` | Access and Identity                                                                                                                                                              |
| [Conversation Routing and Delivery](conversation-routing-and-delivery.md)         | ❌  | `Experimental (42%)` | `Experimental (44%)` | `Experimental (42%)` | Conversation Routing and Delivery                                                                                                                                                |
| [Media and Rich Content](media-and-rich-content.md)                               | ❌  | `Experimental (47%)` | `Alpha (55%)`        | `Experimental (47%)` | Media and Rich Content                                                                                                                                                           |

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

Search anchors: feishu, qq bot, wechat, yuanbao, zalo, zalo personal, regional channels feishu, qq bot, wechat, yuanbao, zalo, zalo personal, regional channels feature matrix: shared regional channel catalog, install, and status, feishu, qq bot, wechat, yuanbao, zalo, zalo personal, regional channels feature matrix: shared regional channel catalog, install, and status.

Category note: [Channel Setup and Operations](shared-regional-channel-catalog-install-status.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Experimental (44%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Docs channel index: Docs channel index, plugin reference pages, redirects, and pairing support list for regional channels
- Official external channel catalog entries: Official external channel catalog entries for WeCom, Yuanbao, Weixin, and adjacent external channels
- Core channel-plugin catalog: Core channel-plugin catalog, alias normalization, install-plan resolution, trusted-source flags, repair hints, and status/list output
- Channel setup wizard: Channel setup wizard and i18n blurbs for regional channels
- Missing-plugin: Missing-plugin, stale-plugin, raw package-manager upgrade, and doctor/repair paths
- Cross-channel ingress/access/refactor concerns: Cross-channel ingress/access/refactor concerns for regional plugins

Primary docs:

- `docs/channels/index.md`
- `docs/channels/pairing.md`
- `docs/plugins/reference/feishu.md`
- `docs/plugins/architecture-internals.md`

### 2. Access and Identity

Search anchors: feishu, qq bot, wechat, yuanbao, zalo, zalo personal, regional channels access and identity, access and identity.

Category note: [Access and Identity](access-and-identity.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Experimental (44%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Access and Identity: Evidence scope for Access and Identity.

Primary docs:

### 3. Conversation Routing and Delivery

Search anchors: feishu, qq bot, wechat, yuanbao, zalo, zalo personal, regional channels conversation routing and delivery, conversation routing and delivery.

Category note: [Conversation Routing and Delivery](conversation-routing-and-delivery.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Experimental (44%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

Primary docs:

### 4. Media and Rich Content

Search anchors: feishu, qq bot, wechat, yuanbao, zalo, zalo personal, regional channels media and rich content, media and rich content.

Category note: [Media and Rich Content](media-and-rich-content.md)

Score decisions:

- Coverage: `Experimental (47%)`
- Quality: `Alpha (55%)`
- Completeness: `Experimental (47%)`
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
  `docs/kevinslin/maturity-scorecard/inventory/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels`.
