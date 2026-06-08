---
title: "iOS app Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Experimental (41%)`
- Quality: `Experimental (45%)`
- Completeness: `Experimental (41%)`
- LTS Features: `0/8`

## Summary

This report promotes the archived `ios-app` maturity evidence from `/Users/kevinlin/tmp/maturity/ios-app` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                   | LTS | Coverage             | Quality              | Completeness         | Features to evaluate                                                                                                                                                         |
| -------------------------------------------------------------------------- | --- | -------------------- | -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Media and Sharing](camera-media-photos-and-share-extension.md)            | ❌  | `Experimental (42%)` | `Experimental (45%)` | `Experimental (42%)` | Camera list/snap/clip                                                                                                                                                        |
| [Canvas and Screen](canvas-screen-and-a2ui.md)                             | ❌  | `Experimental (44%)` | `Experimental (47%)` | `Experimental (44%)` | Canvas present/hide/navigate/eval/snapshot                                                                                                                                   |
| [Chat and Sessions](chat-operator-ui-and-session-controls.md)              | ❌  | `Experimental (40%)` | `Experimental (44%)` | `Experimental (40%)` | Chat sessions and operator controls                                                                                                                                          |
| [Gateway Setup and Diagnostics](settings-permissions-and-diagnostics.md)   | ❌  | `Experimental (41%)` | `Experimental (47%)` | `Experimental (41%)` | Bonjour/local, Manual host/port, Gateway connect configuration persistence, TLS fingerprint trust prompt, Pairing approval, Pairing/auth diagnostics for users, Settings tab |
| [Distribution](install-signing-and-testflight-distribution.md)             | ❌  | `Experimental (42%)` | `Experimental (45%)` | `Experimental (42%)` | Internal preview status                                                                                                                                                      |
| [Device Commands](node-capability-routing-and-device-commands.md)          | ❌  | `Experimental (37%)` | `Experimental (45%)` | `Experimental (37%)` | Location modes, Device command handling                                                                                                                                      |
| [Notifications and Background](relay-push-background-and-live-activity.md) | ❌  | `Experimental (44%)` | `Experimental (46%)` | `Experimental (44%)` | APNs registration and relay delivery                                                                                                                                         |
| [Voice](voice-talk-mode-and-wake.md)                                       | ❌  | `Experimental (38%)` | `Experimental (43%)` | `Experimental (38%)` | Voice wake                                                                                                                                                                   |

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

### 1. Media and Sharing

Search anchors: camera list, photo library, Share Extension.

Category note: [Media and Sharing](camera-media-photos-and-share-extension.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Experimental (45%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Camera list/snap/clip: Camera list/snap/clip, photo-library latest image payloads, screen recording as media, Share Extension draft/send flow, attachment extraction, gateway relay settings for share, and mobile media payload limits

Primary docs:

- `docs/platforms/ios.md`
- `docs/nodes/camera.md`

### 2. Canvas and Screen

Search anchors: Canvas, A2UI, WKWebView.

Category note: [Canvas and Screen](canvas-screen-and-a2ui.md)

Score decisions:

- Coverage: `Experimental (44%)`
- Quality: `Experimental (47%)`
- Completeness: `Experimental (44%)`
- LTS: ❌

Features:

- Canvas present/hide/navigate/eval/snapshot: Canvas present/hide/navigate/eval/snapshot, A2UI reset/push/pushJSONL, WKWebView scaffold loading, trusted A2UI action bridge, screen recording, foreground command gates, and Gateway Canvas host URL handling

Primary docs:

- `docs/platforms/ios.md`
- `docs/plugins/reference/canvas.md`

### 3. Chat and Sessions

Search anchors: Chat tab, chat composer, command-center, session picker.

Category note: [Chat and Sessions](chat-operator-ui-and-session-controls.md)

Score decisions:

- Coverage: `Experimental (40%)`
- Quality: `Experimental (44%)`
- Completeness: `Experimental (40%)`
- LTS: ❌

Features:

- Chat sessions and operator controls: Operator session transport, Chat tab, chat composer/history/streaming/tool display, command-center, permissions, and session controls.

Primary docs:

- `docs/platforms/ios.md`
- `docs/web/webchat.md`
- `docs/gateway/protocol.md`

### 4. Gateway Setup and Diagnostics

Search anchors: Quick start (pair + connect), Discovery paths, Node device pairing, Bonjour / DNS-SD discovery, TLS fingerprint trust, Settings tab, permission toggles, diagnostics.

Category note: [Gateway Setup and Diagnostics](settings-permissions-and-diagnostics.md)

Score decisions:

- Coverage: `Experimental (41%)`
- Quality: `Experimental (47%)`
- Completeness: `Experimental (41%)`
- LTS: ❌

Features:

- Bonjour/local: Bonjour/local and wide-area gateway discovery
- Manual host/port: Manual host/port and QR/setup-code onboarding
- Gateway connect configuration persistence: Gateway connect configuration persistence behavior, status, and operator-visible verification.
- TLS fingerprint trust prompt: TLS fingerprint trust prompt and pinning behavior
- Pairing approval: Pairing approval, device auth/keychain storage, and node+operator session auth
- Pairing/auth diagnostics for users: Pairing/auth diagnostics for users and operators
- Settings tab: Settings tab, Gateway settings, manual networking helpers, QR/setup-code intake, permission toggles and requests, discovery logs, Gateway problem details, diagnostics issue list, notification authorization state, and visible recovery actions

Primary docs:

- `docs/platforms/ios.md`
- `docs/channels/pairing.md`

### 5. Distribution

Search anchors: TestFlight, Xcode manual deploy, signing.

Category note: [Distribution](install-signing-and-testflight-distribution.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Experimental (45%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Internal preview status: Internal preview status, source/Xcode manual deploy, local signing, XcodeGen project generation, Fastlane TestFlight archive/upload, versioning/changelog/metadata, release artifacts, and official-vs-local build flags

Primary docs:

- `docs/platforms/ios.md`

### 6. Device Commands

Search anchors: location, motion activity, calendar, contacts, reminders, node.invoke, device commands, foreground/background command gating.

Category note: [Device Commands](node-capability-routing-and-device-commands.md)

Score decisions:

- Coverage: `Experimental (37%)`
- Quality: `Experimental (45%)`
- Completeness: `Experimental (37%)`
- LTS: ❌

Features:

- Location modes: Location modes, current location, significant-location events, motion activity and pedometer, contacts, calendar, reminders, permission request bridges, and personal-context command payloads
- Device command handling: iOS device command handling, foreground/background gating, command specifications, and capability visibility.

Primary docs:

- `docs/platforms/ios.md`
- `docs/gateway/protocol.md`

### 7. Notifications and Background

Search anchors: APNs registration, push relay, Live Activity, background alive.

Category note: [Notifications and Background](relay-push-background-and-live-activity.md)

Score decisions:

- Coverage: `Experimental (44%)`
- Quality: `Experimental (46%)`
- Completeness: `Experimental (44%)`
- LTS: ❌

Features:

- APNs registration and relay delivery: Direct and relay-backed APNs registration, push relay trust, stored relay handles, background alive windows, and Live Activity updates.

Primary docs:

- `docs/platforms/ios.md`
- `docs/gateway/configuration.md`

### 8. Voice

Search anchors: Voice wake, Talk Mode, push-to-talk.

Category note: [Voice](voice-talk-mode-and-wake.md)

Score decisions:

- Coverage: `Experimental (38%)`
- Quality: `Experimental (43%)`
- Completeness: `Experimental (38%)`
- LTS: ❌

Features:

- Voice wake: Voice wake, trigger-word sync, Talk Mode, push-to-talk commands, realtime Gateway relay, Speech and microphone permissions, audio session coordination, background suspension, and voice settings

Primary docs:

- `docs/platforms/ios.md`
- `docs/nodes/talk.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/ios-app/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/ios-app`.
