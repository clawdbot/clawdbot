---
title: "watchOS companion surfaces Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Experimental (45%)`
- Quality: `Alpha (57%)`
- Completeness: `Experimental (45%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `watchos-companion-surfaces` maturity evidence from `/Users/kevinlin/tmp/maturity/watchos-companion-surfaces` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                          | LTS | Coverage             | Quality              | Completeness         | Features to evaluate                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | --- | -------------------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Delivery and Recovery](apns-background-recovery-and-stale-approval-cleanup.md)   | ❌  | `Experimental (46%)` | `Alpha (60%)`        | `Experimental (46%)` | APNs relay/direct registration as it affects, Silent push, Pending approval recovery IDs, Gateway-side iOS exec approval, iPhone-side WatchConnectivity transport, Watch-side receiver activation, Delivery fallback among reachable messages |
| [Exec Approvals](exec-approval-review-decisions-and-snapshots.md)                 | ❌  | `Alpha (54%)`        | `Alpha (64%)`        | `Alpha (54%)`        | Watch exec approval prompt, Watch approval list/detail UI, iPhone-side prompt caching                                                                                                                                                         |
| [Distribution and Support](packaging-signing-and-distribution-boundary.md)        | ❌  | `Experimental (38%)` | `Experimental (48%)` | `Experimental (38%)` | Watch app, Signing/profile variables, Public/support status, Changelog, Release metadata, Historical bug/regression themes relevant to scoring                                                                                                |
| [Notifications and Replies](watch-notify-command-payloads-and-prompt-defaults.md) | ❌  | `Experimental (44%)` | `Alpha (57%)`        | `Experimental (44%)` | watch.status, Payload normalization, Mirrored iOS notification fallback when watch, Watch action buttons from generic prompt, Watch-to-iPhone reply payloads, iPhone-side dedupe, Mirrored iOS notification action                            |
| [Watch App UI](watch-inbox-ui-and-persistent-state.md)                            | ❌  | `Experimental (42%)` | `Alpha (58%)`        | `Experimental (42%)` | Watch app entry point, Generic inbox, Persistent watch inbox state                                                                                                                                                                            |

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

### 1. Delivery and Recovery

Search anchors: watchos companion surfaces apns background recovery and stale approval cleanup, apns background recovery and stale approval cleanup, watchos companion surfaces watchconnectivity session status and delivery, watchconnectivity session status and delivery.

Category note: [Delivery and Recovery](apns-background-recovery-and-stale-approval-cleanup.md)

Score decisions:

- Coverage: `Experimental (46%)`
- Quality: `Alpha (60%)`
- Completeness: `Experimental (46%)`
- LTS: ❌

Features:

- APNs relay/direct registration as it affects: APNs relay/direct registration as it affects watch approval wake/recovery
- Silent push: Silent push, background refresh, and significant-location wake paths
- Pending approval recovery IDs: Pending approval recovery IDs, snapshot refresh, and resolved/stale cleanup
- Gateway-side iOS exec approval: Gateway-side iOS exec approval APNs targeting
- iPhone-side WatchConnectivity transport: iPhone-side WatchConnectivity transport and status snapshot
- Watch-side receiver activation: Watch-side receiver activation and inbound payload handling
- Delivery fallback among reachable messages: Delivery fallback among reachable messages, queued user info, and application context snapshots

Primary docs:

- `docs/platforms/ios.md`

### 2. Exec Approvals

Search anchors: watchos companion surfaces exec approval review, decisions, and snapshots, exec approval review, decisions, and snapshots.

Category note: [Exec Approvals](exec-approval-review-decisions-and-snapshots.md)

Score decisions:

- Coverage: `Alpha (54%)`
- Quality: `Alpha (64%)`
- Completeness: `Alpha (54%)`
- LTS: ❌

Features:

- Watch exec approval prompt: Watch exec approval prompt, snapshot, resolve, resolved, and expired payloads
- Watch approval list/detail UI: Watch approval list/detail UI and decision buttons
- iPhone-side prompt caching: iPhone-side prompt caching, watch prompt publishing, snapshot handling, and resolution

Primary docs:

- `docs/tools/exec-approvals.md`
- `docs/platforms/ios.md`

### 3. Distribution and Support

Search anchors: watchos companion surfaces packaging, signing, and distribution boundary, packaging, signing, and distribution boundary, watchos companion surfaces source history and release evidence, source history and release evidence.

Category note: [Distribution and Support](packaging-signing-and-distribution-boundary.md)

Score decisions:

- Coverage: `Experimental (38%)`
- Quality: `Experimental (48%)`
- Completeness: `Experimental (38%)`
- LTS: ❌

Features:

- Watch app: Watch app and WatchKit extension targets
- Signing/profile variables: Signing/profile variables, bundle identifiers, icon assets, and iOS beta release flow
- Public/support status: Public/support status for the watch companion as distributed through the iOS app
- Changelog: Changelog and repo-history evidence for watchOS companion maturity
- Release metadata: Release metadata and app-store/TestFlight preparation evidence
- Historical bug/regression themes relevant to scoring: Historical bug/regression themes relevant to scoring current source quality

Primary docs:

- `docs/platforms/ios.md`

### 4. Notifications and Replies

Search anchors: watchos companion surfaces watch notify command, payloads, and prompt defaults, watch notify command, payloads, and prompt defaults, watchos companion surfaces quick reply actions and agent handoff, quick reply actions and agent handoff.

Category note: [Notifications and Replies](watch-notify-command-payloads-and-prompt-defaults.md)

Score decisions:

- Coverage: `Experimental (44%)`
- Quality: `Alpha (57%)`
- Completeness: `Experimental (44%)`
- LTS: ❌

Features:

- watch.status: watch.status and watch.notify command contracts
- Payload normalization: Payload normalization for title/body, prompt/session metadata, priority, risk, and action buttons
- Mirrored iOS notification fallback when watch: Mirrored iOS notification fallback when watch delivery is queued
- Watch action buttons from generic prompt: Watch action buttons from generic prompt notifications
- Watch-to-iPhone reply payloads: Watch-to-iPhone reply payloads behavior, status, and operator-visible verification.
- iPhone-side dedupe: iPhone-side dedupe, offline queueing, and agent request forwarding
- Mirrored iOS notification action: Mirrored iOS notification action fallback

Primary docs:

- `docs/platforms/ios.md`

### 5. Watch App UI

Search anchors: watchos companion surfaces watch inbox ui and persistent state, watch inbox ui and persistent state.

Category note: [Watch App UI](watch-inbox-ui-and-persistent-state.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Alpha (58%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Watch app entry point: Watch app entry point and SwiftUI navigation
- Generic inbox: Generic inbox, prompt actions, exec approval loading/list/detail views
- Persistent watch inbox state: Persistent watch inbox state and duplicate-delivery suppression

Primary docs:

- `docs/platforms/ios.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/watchos-companion-surfaces/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/watchos-companion-surfaces`.
