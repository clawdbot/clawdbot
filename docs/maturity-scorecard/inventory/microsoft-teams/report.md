---
title: "Microsoft Teams Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (62%)`
- Quality: `Alpha (63%)`
- Completeness: `Alpha (62%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `microsoft-teams` maturity evidence from `/Users/kevinlin/tmp/maturity/microsoft-teams` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                           | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Setup and Operations](setup-app-registration-credentials-admin-install.md)                | ❌  | `Alpha (58%)` | `Alpha (64%)` | `Alpha (58%)` | Teams CLI app creation, Bot registration and manifest upload, Credential configuration, Teams app install verification, Setup status, Probe and scope reporting, Teams app doctor, Webhook and health diagnostics, Operator repair paths |
| [Access and Identity](dm-pairing-sender-authorization-config-writes.md)                            | ❌  | `Alpha (60%)` | `Alpha (62%)` | `Alpha (60%)` | DM pairing, Stable sender identity, Allowlists and access groups, Invoke and command authorization, Teams-originated config writes, Bot Framework SSO invokes, Delegated token storage, Graph directory lookup, Member profile lookup    |
| [Conversation Routing and Delivery](team-channel-routing-mention-gates-sessions-thread-context.md) | ❌  | `Alpha (68%)` | `Alpha (66%)` | `Alpha (68%)` | Team and channel allowlists, Deterministic channel replies, Mention-gated group access, Session routing, Reply and thread context                                                                                                        |
| [Media and Rich Content](media-attachments-file-consent-graph-file-flows.md)                       | ❌  | `Alpha (62%)` | `Alpha (58%)` | `Alpha (62%)` | Inbound attachments, Graph-hosted media, File consent, SharePoint and OneDrive sharing, Media fetch safety                                                                                                                               |
| [Native Controls and Approvals](actions-reactions-polls-approvals-group-management.md)             | ❌  | `Alpha (64%)` | `Alpha (66%)` | `Alpha (64%)` | Message action discovery, Polls and reactions, Read, edit, delete, and pin, Native approval cards, Feedback and group actions                                                                                                            |

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

Search anchors: Quick setup, teams app create, app registration, bot registration, Teams app manifest, RSC permissions, credential generation, Configure OpenClaw, MSTEAMS_APP_ID, channels.msteams, Install the app in Teams, teams app doctor, Setup status, Probe and scope reporting, Teams app doctor, Webhook and health diagnostics, Operator repair paths.

Category note: [Channel Setup and Operations](setup-app-registration-credentials-admin-install.md)

Score decisions:

- Coverage: `Alpha (58%)`
- Quality: `Alpha (64%)`
- Completeness: `Alpha (58%)`
- LTS: ❌

Features:

- Teams CLI app creation: Covers Microsoft Teams channel installation through `teams app create`, bot registration, manifest creation, credential generation, and setup verification.
- Bot registration and manifest upload: Covers Entra ID application registration, Azure Bot setup, Teams app manifest/RSC permissions, and Teams app package upload.
- Credential configuration: Covers CLIENT*ID, CLIENT_SECRET, TENANT_ID, `MSTEAMS*\*`environment variables, and OpenClaw`channels.msteams` credential configuration.
- Teams app install verification: Covers Teams install links, app installation in Teams, and `teams app doctor` verification after setup.
- Setup status: Covers Setup status across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Probe and scope reporting: Covers Probe and scope reporting across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Teams app doctor: Covers Teams app doctor across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Webhook and health diagnostics: Covers Webhook and health diagnostics across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Operator repair paths: Covers Operator repair paths across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.

Primary docs:

- `docs/channels/msteams.md`
- `docs/plugins/reference/msteams.md`
- `docs/gateway/config-channels.md`
- `docs/gateway/health.md`

### 2. Access and Identity

Search anchors: DM pairing, Stable sender identity, Allowlists and access groups, Invoke and command authorization, Teams-originated config writes, Bot Framework SSO invokes, OAuth token exchange, delegated token storage, Graph app token resolution, member info.

Category note: [Access and Identity](dm-pairing-sender-authorization-config-writes.md)

Score decisions:

- Coverage: `Alpha (60%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (60%)`
- LTS: ❌

Features:

- DM pairing: Covers DM pairing across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Stable sender identity: Covers Stable sender identity across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Allowlists and access groups: Covers Allowlists and access groups across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Invoke and command authorization: Covers Invoke and command authorization across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Teams-originated config writes: Covers Teams-originated config writes across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Bot Framework SSO invokes: Covers Bot Framework SSO invoke handling and OAuth token exchange for Microsoft Teams users.
- Delegated token storage: Covers delegated token storage, token refresh, and recovery for Microsoft Teams user auth.
- Graph directory lookup: Covers Graph app token resolution and directory lookup behavior for Teams routing and user metadata.
- Member profile lookup: Covers member info lookup and user metadata retrieval for Microsoft Teams conversations.

Primary docs:

- `docs/channels/msteams.md`
- `docs/channels/pairing.md`
- `docs/channels/access-groups.md`

### 3. Conversation Routing and Delivery

Search anchors: Teams + channel allowlist, deterministic routing, replies always go back to the channel, mention-gated, Session key shapes, groupPolicy, groupAllowFrom, requireMention, channel routing, Reply context.

Category note: [Conversation Routing and Delivery](team-channel-routing-mention-gates-sessions-thread-context.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (66%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- Team and channel allowlists: Covers Teams/channel allowlists, stable conversation IDs, `channels.msteams.teams`, wildcard routing, and team/channel name resolution.
- Deterministic channel replies: Covers deterministic reply routing back to the Teams channel where a message arrived and wildcard routing safeguards.
- Mention-gated group access: Covers `groupPolicy`, `groupAllowFrom`, `requireMention`, and mention-gated group or channel replies.
- Session routing: Covers deterministic reply routing, session keys, channel bindings, and conversation isolation for Microsoft Teams rooms and channels.
- Reply and thread context: Covers reply context, quoted source messages, thread-aware routing, and room context for Teams conversations.

Primary docs:

- `docs/channels/msteams.md`
- `docs/channels/groups.md`
- `docs/channels/channel-routing.md`

### 4. Media and Rich Content

Search anchors: Inbound attachments, Graph-hosted media, File consent, SharePoint and OneDrive sharing, Media fetch safety.

Category note: [Media and Rich Content](media-attachments-file-consent-graph-file-flows.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- Inbound attachments: Covers Inbound attachments across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- Graph-hosted media: Covers Graph-hosted media across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- File consent: Covers File consent across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- SharePoint and OneDrive sharing: Covers SharePoint and OneDrive sharing across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- Media fetch safety: Covers Media fetch safety across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.

Primary docs:

- `docs/channels/msteams.md`

### 5. Native Controls and Approvals

Search anchors: Message action discovery, Polls and reactions, Read, edit, delete, and pin, Native approval cards, Feedback and group actions.

Category note: [Native Controls and Approvals](actions-reactions-polls-approvals-group-management.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (66%)`
- Completeness: `Alpha (64%)`
- LTS: ❌

Features:

- Message action discovery: Covers Message action discovery across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Polls and reactions: Covers Polls and reactions across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Read, edit, delete, and pin: Covers Read, edit, delete, and pin across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Native approval cards: Covers Native approval cards across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Feedback and group actions: Covers Feedback and group actions across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.

Primary docs:

- `docs/channels/msteams.md`
- `docs/tools/exec-approvals-advanced.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/microsoft-teams/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/microsoft-teams`.
