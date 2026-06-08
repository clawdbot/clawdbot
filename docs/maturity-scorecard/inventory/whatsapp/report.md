---
title: "WhatsApp Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (76%)`
- Quality: `Beta (76%)`
- Completeness: `Beta (76%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `whatsapp` maturity evidence from `/Users/kevinlin/tmp/maturity/whatsapp` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                              | LTS | Coverage     | Quality        | Completeness | Features to evaluate                                                                                                                                                                                  |
| --------------------------------------------------------------------- | --- | ------------ | -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Setup and Operations](operator-install-and-configuration.md) | ❌  | `Beta (74%)` | `Beta (72%)`   | `Beta (74%)` | Official @openclaw/whatsapp plugin metadata, openclaw plugin install whatsapp, Channel config schema, Baileys socket lifecycle, Operator troubleshooting                                              |
| [Access and Identity](pairing-login-and-session-auth.md)              | ❌  | `Beta (76%)` | `Beta (72%)`   | `Beta (76%)` | QR login, Baileys multi-file auth persistence, DM pairing challenge, Multi-account/default-account resolution, Direct-message dmPolicy, Sender identity extraction, Privacy controls for plugin hooks |
| [Conversation Routing and Delivery](group-routing-and-activation.md)  | ❌  | `Beta (76%)` | `Beta (72%)`   | `Beta (76%)` | Group allowlists, Group session keys, Outbound text sends, Provider-accepted receipts                                                                                                                 |
| [Media and Rich Content](media-attachments-and-voice.md)              | ❌  | `Beta (76%)` | `Stable (80%)` | `Beta (76%)` | Inbound media download, Outbound image                                                                                                                                                                |
| [Native Controls and Approvals](native-approvals-and-reactions.md)    | ❌  | `Beta (78%)` | `Stable (84%)` | `Beta (78%)` | Native exec, Approver target resolution                                                                                                                                                               |

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

Search anchors: whatsapp operator install and configuration, operator install and configuration, whatsapp runtime health reconnect and doctor, runtime health reconnect and doctor.

Category note: [Channel Setup and Operations](operator-install-and-configuration.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Official @openclaw/whatsapp plugin metadata: Official @openclaw/whatsapp plugin metadata, package entrypoints, and setup discovery.
- openclaw plugin install whatsapp: openclaw plugin install whatsapp and config-first setup guidance
- Channel config schema: Channel config schema, plugin hooks, setup finalization, default account, and secret handling.
- Baileys socket lifecycle: Baileys socket lifecycle, connection controller state, reconnect decisions, and repair status.
- Operator troubleshooting: Operator troubleshooting for reconnect loops, stale sockets, Bun/Node runtime

Primary docs:

- `docs/channels/whatsapp.md`
- `docs/gateway/config-channels.md`
- `docs/plugins/reference/whatsapp.md`
- `docs/concepts/qa-e2e-automation.md`
- `docs/gateway/doctor.md`

### 2. Access and Identity

Search anchors: whatsapp pairing login and session auth, pairing login and session auth, whatsapp inbound dm access and privacy, inbound dm access and privacy.

Category note: [Access and Identity](pairing-login-and-session-auth.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- QR login: QR login and agent login QR flows
- Baileys multi-file auth persistence: Baileys multi-file auth persistence, queued credential writes, backup restore, and login recovery.
- DM pairing challenge: DM pairing challenge and allow-store persistence where it intersects WhatsApp
- Multi-account/default-account resolution: Multi-account/default-account resolution and Baileys 515/401 recovery
- Direct-message dmPolicy: Direct-message dmPolicy, allowFrom, pairing challenge, pairing-store
- Sender identity extraction: Sender identity extraction, read receipts, self-chat safeguards, and contact matching.
- Privacy controls for plugin hooks: Privacy controls for plugin hooks and untrusted context

Primary docs:

- `docs/channels/whatsapp.md`
- `docs/gateway/config-channels.md`
- `docs/concepts/qa-e2e-automation.md`
- `docs/channels/pairing.md`

### 3. Conversation Routing and Delivery

Search anchors: whatsapp group routing and activation, group routing and activation, whatsapp outbound delivery and targeting, outbound delivery and targeting.

Category note: [Conversation Routing and Delivery](group-routing-and-activation.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Group allowlists: Group allowlists, groupPolicy, exact group JIDs, requireMention, owner
- Group session keys: Group session keys, broadcast fanout, outbound mentions, and group prompt
- Outbound text sends: Outbound text sends, message-tool delivery, explicit DM/group/newsletter
- Provider-accepted receipts: Provider-accepted receipts and durable delivery identifiers

Primary docs:

- `docs/channels/whatsapp.md`
- `docs/channels/group-messages.md`

### 4. Media and Rich Content

Search anchors: whatsapp media attachments and voice, media attachments and voice.

Category note: [Media and Rich Content](media-attachments-and-voice.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Stable (80%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Inbound media download: Inbound media download and placeholder construction, quoted media extraction, and file handoff.
- Outbound image: Outbound image, audio, video, document, and voice-note payload construction.

Primary docs:

- `docs/channels/whatsapp.md`

### 5. Native Controls and Approvals

Search anchors: whatsapp native approvals and reactions, native approvals and reactions.

Category note: [Native Controls and Approvals](native-approvals-and-reactions.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Stable (84%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Native exec: Native exec and plugin approval delivery through WhatsApp
- Approver target resolution: Approver target resolution, DM/group target eligibility, route suppression, and approval delivery.

Primary docs:

- `docs/channels/whatsapp.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/whatsapp/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/whatsapp`.
