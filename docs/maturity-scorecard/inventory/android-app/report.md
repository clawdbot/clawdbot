---
title: "Android app Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (65%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (65%)`
- LTS Features: `0/7`

## Summary

This report promotes the archived `android-app` maturity evidence from `/Users/kevinlin/tmp/maturity/android-app` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                        | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                        |
| ----------------------------------------------- | --- | ------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------- |
| [Media Capture](camera-media-capture.md)        | ❌  | `Alpha (66%)` | `Alpha (62%)` | `Alpha (66%)` | Camera and media capture                                                                    |
| [Mobile Chat](chat-sessions-ui.md)              | ❌  | `Beta (70%)`  | `Alpha (66%)` | `Beta (70%)`  | Chat tab                                                                                    |
| [Connection Setup](gateway-pairing-security.md) | ❌  | `Alpha (68%)` | `Alpha (64%)` | `Alpha (68%)` | Gateway discovery                                                                           |
| [Distribution](install-release-distribution.md) | ❌  | `Alpha (60%)` | `Alpha (62%)` | `Alpha (60%)` | Public Google Play install path, Manual install path, Release smoke and startup performance |
| [Settings](settings-permissions-diagnostics.md) | ❌  | `Alpha (64%)` | `Alpha (66%)` | `Alpha (64%)` | Settings sheet                                                                              |
| [Voice](voice-talk-wake.md)                     | ❌  | `Alpha (66%)` | `Alpha (60%)` | `Alpha (66%)` | Voice tab                                                                                   |
| [Device Runtime](node-device-capabilities.md)   | ❌  | `Alpha (62%)` | `Alpha (55%)` | `Alpha (62%)` | Background reconnect and presence, Device command availability                              |

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

### 1. Media Capture

Search anchors: camera.list, camera.capture, screen capture.

Category note: [Media Capture](camera-media-capture.md)

Score decisions:

- Coverage: `Alpha (66%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (66%)`
- LTS: ❌

Features:

- Camera and media capture: Camera listing, capture, photo, screen, and media capture behavior.

Primary docs:

- `docs/platforms/android.md`
- `docs/nodes/camera.md`

### 2. Mobile Chat

Search anchors: Chat tab, chat.history, mobile UI.

Category note: [Mobile Chat](chat-sessions-ui.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Chat tab: Chat tab, session list/filtering, composer, image attachments, message parsing/rendering, model/provider status adjacent to chat, and Gateway chat RPC integration

Primary docs:

- `docs/platforms/android.md`

### 3. Connection Setup

Search anchors: Setup Code, Manual, Bonjour.

Category note: [Connection Setup](gateway-pairing-security.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (64%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- Gateway discovery: Gateway discovery, setup-code and manual endpoint parsing, WS/WSS connection setup, TLS trust decisions, device identity, stored device tokens, node/operator auth, and connection error handling

Primary docs:

- `docs/platforms/android.md`
- `docs/gateway/bonjour.md`
- `docs/gateway/pairing.md`

### 4. Distribution

Search anchors: Google Play, Manual, Startup macrobenchmark.

Category note: [Distribution](install-release-distribution.md)

Score decisions:

- Coverage: `Alpha (60%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (60%)`
- LTS: ❌

Features:

- Public Google Play install path: Public Google Play install path and source build/run entrypoints
- Manual install path: Manual install path and Google Play distribution behavior.
- Release smoke and startup performance: Release smoke and startup performance checks for Android app distribution.

Primary docs:

- `docs/platforms/android.md`

### 5. Settings

Search anchors: Settings sheet, Notification forwarding, diagnostics.

Category note: [Settings](settings-permissions-diagnostics.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (66%)`
- Completeness: `Alpha (64%)`
- LTS: ❌

Features:

- Settings sheet: Settings sheet and settings detail screens, permission request UX, notification forwarding controls, Nodes & Devices status, provider/model diagnostics, secure preferences, and copyable Gateway diagnostic report

Primary docs:

- `docs/platforms/android.md`

### 6. Voice

Search anchors: Talk Mode, Voice tab, wake.

Category note: [Voice](voice-talk-wake.md)

Score decisions:

- Coverage: `Alpha (66%)`
- Quality: `Alpha (60%)`
- Completeness: `Alpha (66%)`
- LTS: ❌

Features:

- Voice tab: Voice tab, manual mic capture, Talk Mode listen/think/speak loop, Gateway Talk config, talk.speak, realtime relay mode, voice capture service type, and voice e2e receiver/script

Primary docs:

- `docs/platforms/android.md`
- `docs/nodes/talk.md`

### 7. Device Runtime

Search anchors: foreground service, node.presence.alive, background reconnect, Additional Android command families, node capabilities, command handling.

Category note: [Device Runtime](node-device-capabilities.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Alpha (55%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- Background reconnect and presence: Foreground-service presence, reconnect, and node presence behavior.
- Device command availability: Android device command availability and capability advertisement.

Primary docs:

- `docs/platforms/android.md`
- `docs/nodes/troubleshooting.md`
- `docs/gateway/protocol.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/android-app/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/android-app`.
