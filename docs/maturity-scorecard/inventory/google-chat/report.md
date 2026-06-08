---
title: "Google Chat Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (57%)`
- Quality: `Alpha (53%)`
- Completeness: `Alpha (57%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `google-chat` maturity evidence from `/Users/kevinlin/tmp/maturity/google-chat` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                             | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | --- | ------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Setup and Operations](setup-auth-and-workspace-app.md)                      | ❌  | `Alpha (64%)` | `Alpha (62%)` | `Alpha (64%)` | Google Cloud project setup, Chat app configuration, Service account setup, Webhook audience and path, Workspace visibility and app status, Guided channel setup, Account resolution, Service account SecretRefs, Env file and inline credentials, Channel status and probes, Directory and mutable-id diagnostics, NPM and ClawHub install, Plugin docs and catalog routing, Channel aliases and labels, Operator status UI, Install/update metadata |
| [Access and Identity](dm-pairing-and-sender-authorization.md)                        | ❌  | `Alpha (58%)` | `Alpha (55%)` | `Alpha (58%)` | DM pairing approval, Sender allowlists, Google Chat identity matching, Direct session routing, Pairing diagnostics, Space allowlists, Mention gating, Sender access groups, Group session isolation, Bot-loop protection, Space diagnostics                                                                                                                                                                                                          |
| [Conversation Routing and Delivery](space-routing-mentions-and-session-isolation.md) | ❌  | `Alpha (55%)` | `Alpha (50%)` | `Alpha (55%)` | Conversation Routing and Delivery                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [Media and Rich Content](media-attachments-and-file-transfer.md)                     | ❌  | `Alpha (55%)` | `Alpha (50%)` | `Alpha (55%)` | Media and Rich Content                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [Native Controls and Approvals](message-actions-reactions-and-approval-auth.md)      | ❌  | `Alpha (55%)` | `Alpha (50%)` | `Alpha (55%)` | Inbound attachments, Outbound media replies, Message upload action, Media source and size controls, Media receipts and thread placement, Text send action, Upload-file action, Reaction actions, Action capability gates, Approval sender matching, Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering                                |

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

Search anchors: Google Cloud project setup, Chat app configuration, Service account setup, Webhook audience and path, Workspace visibility and app status, Guided channel setup, DM pairing, dm.policy, Account resolution, Service account SecretRefs, Env file and inline credentials, Channel status and probes, Directory and mutable-id diagnostics, allowFrom, NPM and ClawHub install, Plugin docs and catalog routing, Channel aliases and labels, Operator status UI, Install/update metadata.

Category note: [Channel Setup and Operations](setup-auth-and-workspace-app.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (64%)`
- LTS: ❌

Features:

- Google Cloud project setup: Covers Google Cloud project setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Chat app configuration: Covers Chat app configuration across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Service account setup: Covers Service account setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Webhook audience and path: Covers Webhook audience and path across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Workspace visibility and app status: Covers Workspace visibility and app status across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Guided channel setup: Covers Guided channel setup across Google Chat plugin installation, Google Cloud project and Chat API setup, service account JSON/file/env credential selection, `audienceType`, and related setup auth and workspace app behavior.
- Account resolution: Covers Account resolution across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Service account SecretRefs: Covers Service account SecretRefs across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Env file and inline credentials: Covers Env file and inline credentials across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Channel status and probes: Covers Channel status and probes across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Directory and mutable-id diagnostics: Covers Directory and mutable-id diagnostics across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- NPM and ClawHub install: Covers NPM and ClawHub install across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Plugin docs and catalog routing: Covers Plugin docs and catalog routing across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Channel aliases and labels: Covers Channel aliases and labels across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Operator status UI: Covers Operator status UI across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.
- Install/update metadata: Covers Install/update metadata across npm/ClawHub plugin metadata, docs navigation, plugin references, official external plugin catalog, and related plugin distribution operator ui and docs behavior.

Primary docs:

- `docs/channels/googlechat.md`
- `docs/plugins/reference/googlechat.md`
- `docs/gateway/config-channels.md`
- `docs/start/wizard-cli-reference.md`
- `docs/gateway/secrets.md`
- `docs/reference/secretref-credential-surface.md`
- `docs/gateway/health.md`
- `docs/plugins/plugin-inventory.md`
- `docs/channels/index.md`
- `docs/docs.json`

### 2. Access and Identity

Search anchors: DM pairing approval, Sender allowlists, Google Chat identity matching, Direct session routing, Pairing diagnostics, DM pairing, dm.policy, allowFrom, Space allowlists, Mention gating, Sender access groups, Group session isolation, Bot-loop protection, Space diagnostics.

Category note: [Access and Identity](dm-pairing-and-sender-authorization.md)

Score decisions:

- Coverage: `Alpha (58%)`
- Quality: `Alpha (55%)`
- Completeness: `Alpha (58%)`
- LTS: ❌

Features:

- DM pairing approval: Covers DM pairing approval across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Sender allowlists: Covers Sender allowlists across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Google Chat identity matching: Covers Google Chat identity matching across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Direct session routing: Covers Direct session routing across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Pairing diagnostics: Covers Pairing diagnostics across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Space allowlists: Covers Space allowlists across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Mention gating: Covers Mention gating across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Sender access groups: Covers Sender access groups across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Group session isolation: Covers Group session isolation across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Bot-loop protection: Covers Bot-loop protection across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Space diagnostics: Covers Space diagnostics across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.

Primary docs:

- `docs/channels/googlechat.md`
- `docs/channels/pairing.md`
- `docs/channels/access-groups.md`
- `docs/gateway/config-channels.md`
- `docs/channels/bot-loop-protection.md`
- `docs/channels/channel-routing.md`

### 3. Conversation Routing and Delivery

Search anchors: google chat conversation routing and delivery, conversation routing and delivery.

Category note: [Conversation Routing and Delivery](space-routing-mentions-and-session-isolation.md)

Score decisions:

- Coverage: `Alpha (55%)`
- Quality: `Alpha (50%)`
- Completeness: `Alpha (55%)`
- LTS: ❌

Features:

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

Primary docs:

- `docs/channels/googlechat.md`
- `docs/channels/bot-loop-protection.md`
- `docs/channels/access-groups.md`
- `docs/channels/channel-routing.md`

### 4. Media and Rich Content

Search anchors: google chat media and rich content, media and rich content.

Category note: [Media and Rich Content](media-attachments-and-file-transfer.md)

Score decisions:

- Coverage: `Alpha (55%)`
- Quality: `Alpha (50%)`
- Completeness: `Alpha (55%)`
- LTS: ❌

Features:

- Media and Rich Content: Evidence scope for Media and Rich Content.

Primary docs:

- `docs/channels/googlechat.md`
- `docs/cli/message.md`
- `docs/nodes/media-understanding.md`
- `docs/reference/secretref-credential-surface.md`

### 5. Native Controls and Approvals

Search anchors: Inbound attachments, Outbound media replies, Message upload action, Media source and size controls, Media receipts and thread placement, DM pairing, dm.policy, allowFrom, Text send action, Upload-file action, Reaction actions, Action capability gates, Approval sender matching, Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering.

Category note: [Native Controls and Approvals](message-actions-reactions-and-approval-auth.md)

Score decisions:

- Coverage: `Alpha (55%)`
- Quality: `Alpha (50%)`
- Completeness: `Alpha (55%)`
- LTS: ❌

Features:

- Inbound attachments: Covers Inbound attachments across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Outbound media replies: Covers Outbound media replies across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Message upload action: Covers Message upload action across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Media source and size controls: Covers Media source and size controls across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Media receipts and thread placement: Covers Media receipts and thread placement across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Text send action: Covers Text send action across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Upload-file action: Covers Upload-file action across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Reaction actions: Covers Reaction actions across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Action capability gates: Covers Action capability gates across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Approval sender matching: Covers Approval sender matching across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Thread-aware replies: Covers Thread-aware replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Streaming and chunked replies: Covers Streaming and chunked replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Typing placeholder lifecycle: Covers Typing placeholder lifecycle across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Message-tool current-source replies: Covers Message-tool current-source replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- NO_REPLY cleanup: Covers NO_REPLY cleanup across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Markdown/text rendering: Covers Markdown/text rendering across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.

Primary docs:

- `docs/channels/googlechat.md`
- `docs/cli/message.md`
- `docs/nodes/media-understanding.md`
- `docs/reference/secretref-credential-surface.md`
- `docs/tools/reactions.md`
- `docs/tools/slash-commands.md`
- `docs/gateway/config-agents.md`
- `docs/concepts/message-lifecycle-refactor.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/google-chat/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/google-chat`.
