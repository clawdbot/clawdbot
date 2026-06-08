---
title: "Signal Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (66%)`
- Quality: `Alpha (65%)`
- Completeness: `Alpha (66%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `signal` maturity evidence from `/Users/kevinlin/tmp/maturity/signal` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                 | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                         |
| ------------------------------------------------------------------------ | --- | ------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Setup and Operations](setup-install-account-provisioning.md)    | ❌  | `Alpha (55%)` | `Alpha (58%)` | `Alpha (55%)` | QR link setup, SMS registration, Installer and binary setup, Container account provisioning, Status probes, Setup diagnostics, Account safety guardrails                     |
| [Access and Identity](dm-pairing-access-control.md)                      | ❌  | `Beta (70%)`  | `Alpha (66%)` | `Beta (70%)`  | DM pairing, DM allowlists, Sender identity normalization, Group allowlists, Mention gates, Pending group history                                                             |
| [Conversation Routing and Delivery](group-routing-mention-history.md)    | ❌  | `Beta (70%)`  | `Alpha (66%)` | `Beta (70%)`  | Conversation Routing and Delivery                                                                                                                                            |
| [Media and Rich Content](outbound-delivery-media-receipts.md)            | ❌  | `Beta (70%)`  | `Alpha (68%)` | `Beta (70%)`  | Text delivery targets, Media delivery and limits, Typing and read receipts, Styled/chunked output, Reaction action discovery, Add/remove reactions, Group reaction targeting |
| [Native Controls and Approvals](approval-routing-reaction-resolution.md) | ❌  | `Alpha (65%)` | `Alpha (68%)` | `Alpha (65%)` | Native approval routing, Reaction approval responses, Approver targeting                                                                                                     |

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

Search anchors: QR link setup, SMS registration, Installer and binary setup, Container account provisioning, dmPolicy, allowFrom, groupPolicy, requireMention, Status probes, Setup diagnostics, Account safety guardrails, historyLimit.

Category note: [Channel Setup and Operations](setup-install-account-provisioning.md)

Score decisions:

- Coverage: `Alpha (55%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (55%)`
- LTS: ❌

Features:

- QR link setup: Defines QR link setup setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- SMS registration: Defines SMS registration setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Installer and binary setup: Defines Installer and binary setup setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Container account provisioning: Defines Container account provisioning setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Status probes: Defines Status probes setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Setup diagnostics: Defines Setup diagnostics setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Account safety guardrails: Defines Account safety guardrails setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.

Primary docs:

- `docs/channels/signal.md`
- `docs/plugins/reference/signal.md`

### 2. Access and Identity

Search anchors: DM pairing, DM allowlists, Sender identity normalization, dmPolicy, allowFrom, groupPolicy, requireMention, historyLimit, Group allowlists, Mention gates, Pending group history.

Category note: [Access and Identity](dm-pairing-access-control.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- DM pairing: Defines DM pairing setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- DM allowlists: Defines DM allowlists setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Sender identity normalization: Defines Sender identity normalization setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Group allowlists: Defines Group allowlists authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Mention gates: Defines Mention gates authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Pending group history: Defines Pending group history authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.

Primary docs:

- `docs/channels/signal.md`

### 3. Conversation Routing and Delivery

Search anchors: signal conversation routing and delivery, conversation routing and delivery.

Category note: [Conversation Routing and Delivery](group-routing-mention-history.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

Primary docs:

- `docs/channels/signal.md`

### 4. Media and Rich Content

Search anchors: Text delivery targets, Media delivery and limits, Typing and read receipts, Styled/chunked output, dmPolicy, allowFrom, groupPolicy, requireMention, Reaction action discovery, Add/remove reactions, Group reaction targeting, historyLimit.

Category note: [Media and Rich Content](outbound-delivery-media-receipts.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Text delivery targets: Covers Text delivery targets routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Media delivery and limits: Covers Media delivery and limits routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Typing and read receipts: Covers Typing and read receipts routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Styled/chunked output: Covers Styled/chunked output routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Reaction action discovery: Covers Reaction action discovery routing, session binding, history, and conversation context for Reactions Message Tool.
- Add/remove reactions: Covers Add/remove reactions routing, session binding, history, and conversation context for Reactions Message Tool.
- Group reaction targeting: Covers Group reaction targeting routing, session binding, history, and conversation context for Reactions Message Tool.

Primary docs:

- `docs/channels/signal.md`

### 5. Native Controls and Approvals

Search anchors: Native approval routing, Reaction approval responses, Approver targeting, dmPolicy, allowFrom, groupPolicy, requireMention, historyLimit.

Category note: [Native Controls and Approvals](approval-routing-reaction-resolution.md)

Score decisions:

- Coverage: `Alpha (65%)`
- Quality: `Alpha (68%)`
- Completeness: `Alpha (65%)`
- LTS: ❌

Features:

- Native approval routing: Defines Native approval routing authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.
- Reaction approval responses: Defines Reaction approval responses authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.
- Approver targeting: Defines Approver targeting authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.

Primary docs:

- `docs/channels/signal.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/signal/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/signal`.
