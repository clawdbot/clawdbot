---
title: "Matrix Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (72%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (72%)`
- LTS Features: `0/6`

## Summary

This report promotes the archived `matrix` maturity evidence from `/Users/kevinlin/tmp/maturity/matrix` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                           | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Channel Setup and Operations](setup-config-and-account-selection.md)              | ❌  | `Beta (74%)`  | `Beta (74%)`  | `Beta (74%)`  | Matrix plugin identity, Setup wizard, Account discovery, Matrix doctor warnings, Matrix probe/status                                                                                                   |
| [Access and Identity](dm-room-routing-and-access-policy.md)                        | ❌  | `Beta (72%)`  | `Alpha (66%)` | `Beta (72%)`  | DM policy, Direct-room classification, Inbound route selection across sender-bound DMs, Mention gates, Matrix thread reply routing, Persisted Matrix thread routing managers, ACP/subagent spawn hooks |
| [Conversation Routing and Delivery](threads-acp-and-subagent-bindings.md)          | ❌  | `Beta (72%)`  | `Alpha (66%)` | `Beta (72%)`  | Conversation Routing and Delivery                                                                                                                                                                      |
| [Media and Rich Content](outbound-messages-media-and-streaming.md)                 | ❌  | `Beta (74%)`  | `Alpha (68%)` | `Beta (74%)`  | Media and Rich Content                                                                                                                                                                                 |
| [Native Controls and Approvals](actions-profile-polls-reactions-and-room-tools.md) | ❌  | `Alpha (64%)` | `Alpha (68%)` | `Alpha (64%)` | Channel action discovery, Message send/read/edit/delete, Profile media loading, Outbound Matrix text, Message presentation metadata, Inbound media failure handling                                    |
| [Encryption and Verification](e2ee-verification-backup-and-migration.md)           | ❌  | `Beta (76%)`  | `Alpha (68%)` | `Beta (76%)`  | Encryption setup, Encrypted media upload/download, Legacy state                                                                                                                                        |

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

Search anchors: matrix setup, config, and account selection, setup, config, and account selection, matrix diagnostics, doctor, and operational repair, diagnostics, doctor, and operational repair.

Category note: [Channel Setup and Operations](setup-config-and-account-selection.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Matrix plugin identity: Matrix plugin identity, install metadata, runtime/setup entries, and account configuration.
- Setup wizard: Setup wizard, setup adapter, validation, post-write bootstrap, and account setup.
- Account discovery: Account discovery, default account rules, env-backed accounts, and stored account metadata.
- Matrix doctor warnings: Matrix doctor warnings, config normalization, and stale plugin config cleanup.
- Matrix probe/status: Matrix probe/status, live directory lookup, CLI diagnostics, and QA runtime status.

Primary docs:

- `docs/channels/matrix.md`
- `docs/channels/matrix-migration.md`

### 2. Access and Identity

Search anchors: matrix dm room routing and access policy, dm room routing and access policy, matrix threads, acp, and subagent bindings, threads, acp, and subagent bindings.

Category note: [Access and Identity](dm-room-routing-and-access-policy.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- DM policy: DM policy, pairing, allowFrom, groupAllowFrom, room allowlists, and live access checks.
- Direct-room classification: Direct-room classification and repair-adjacent routing decisions
- Inbound route selection across sender-bound DMs: Inbound route selection across sender-bound DMs, room bindings, and account-scoped routes.
- Mention gates: Mention gates, slash command access checks, bot-loop suppression, and context admission.
- Matrix thread reply routing: Matrix thread reply routing, thread root/context extraction, and thread-aware session placement.
- Persisted Matrix thread routing managers: Persisted Matrix thread binding managers, child session binding, and activity tracking.
- ACP/subagent spawn hooks: ACP/subagent spawn hooks and Matrix delivery targets for child sessions

Primary docs:

- `docs/channels/matrix.md`
- `docs/channels/groups.md`
- `docs/channels/bot-loop-protection.md`

### 3. Conversation Routing and Delivery

Search anchors: matrix conversation routing and delivery, conversation routing and delivery.

Category note: [Conversation Routing and Delivery](threads-acp-and-subagent-bindings.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

Primary docs:

- `docs/channels/matrix.md`

### 4. Media and Rich Content

Search anchors: matrix media and rich content, media and rich content.

Category note: [Media and Rich Content](outbound-messages-media-and-streaming.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Media and Rich Content: Evidence scope for Media and Rich Content.

Primary docs:

- `docs/channels/matrix.md`

### 5. Native Controls and Approvals

Search anchors: matrix actions, profile, polls, reactions, and room tools, actions, profile, polls, reactions, and room tools, matrix outbound messages, media, and streaming, outbound messages, media, and streaming.

Category note: [Native Controls and Approvals](actions-profile-polls-reactions-and-room-tools.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (68%)`
- Completeness: `Alpha (64%)`
- LTS: ❌

Features:

- Channel action discovery: Channel action discovery, account-scoped action gates, and tool schemas
- Message send/read/edit/delete: Message send/read/edit/delete, poll voting, reaction add/remove/list, pins, and related room tools.
- Profile media loading: Profile media loading from URL or local path.
- Outbound Matrix text: Outbound Matrix text, media, encrypted media, poll, typing, read receipt, and delivery behavior.
- Message presentation metadata: Message presentation metadata, Matrix mention metadata, and chunked delivery behavior.
- Inbound media failure handling: Inbound media download failure handling when it affects outbound replies.

Primary docs:

- `docs/channels/matrix.md`

### 6. Encryption and Verification

Search anchors: matrix e2ee, verification, backup, and migration, e2ee, verification, backup, and migration.

Category note: [Encryption and Verification](e2ee-verification-backup-and-migration.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Encryption setup: Encryption setup, crypto availability, recovery-key storage, and secret storage.
- Encrypted media upload/download: Encrypted media upload/download and startup verification notices
- Legacy state: Legacy state and crypto migration, migration snapshots, and gateway startup repair.

Primary docs:

- `docs/channels/matrix.md`
- `docs/channels/matrix-migration.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/matrix/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/matrix`.
