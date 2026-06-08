---
title: "iMessage / BlueBubbles Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (71%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (71%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `imessage-bluebubbles` maturity evidence from `/Users/kevinlin/tmp/maturity/imessage-bluebubbles` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                  | LTS | Coverage      | Quality      | Completeness  | Features to evaluate                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | --- | ------------- | ------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Setup and Operations](setup-status-doctor-and-account-config.md)                 | ❌  | `Alpha (62%)` | `Beta (70%)` | `Alpha (62%)` | Translate legacy config, Cut over safely, Handle migration caveats, Run local imsg, Run through SSH wrapper, Grant macOS permissions, Probe runtime health, Account setup prompts, Account status checks, Doctor repair checks, Account Config |
| [Access and Identity](dm-pairing-access-and-session-routing.md)                           | ❌  | `Beta (75%)`  | `Beta (74%)` | `Beta (75%)`  | Authorize direct senders, Route direct conversations, Bind ACP sessions, Group Policy, Mentions, System Prompts                                                                                                                                |
| [Conversation Routing and Delivery](inbound-monitoring-coalescing-catchup-and-history.md) | ❌  | `Beta (74%)`  | `Beta (73%)` | `Beta (74%)`  | Watch live messages, Coalesce split-send DMs, Replay missed messages, Seed conversation history                                                                                                                                                |
| [Media and Rich Content](media-attachments-remote-fetch-and-chunking.md)                  | ❌  | `Beta (73%)`  | `Beta (71%)` | `Beta (73%)`  | Media, Attachments, Remote Fetch, Chunking, Native Actions, Private API, Message Tool                                                                                                                                                          |
| [Native Controls and Approvals](native-approvals-reactions-and-operator-control.md)       | ❌  | `Beta (73%)`  | `Beta (71%)` | `Beta (73%)`  | Native Approvals, Reactions, Operator Control                                                                                                                                                                                                  |

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

Search anchors: Translate legacy config, Cut over safely, Handle migration caveats, Run local imsg, Run through SSH wrapper, Grant macOS permissions, Probe runtime health, setup prompts, policy writes, account status, doctor checks, Account Config, imessage / bluebubbles setup, status, doctor, and account config, setup, status, doctor, and account config.

Category note: [Channel Setup and Operations](setup-status-doctor-and-account-config.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Beta (70%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- Translate legacy config: Covers Translate legacy config across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Cut over safely: Covers Cut over safely across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Handle migration caveats: Covers Handle migration caveats across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Run local imsg: Covers Run local imsg across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Run through SSH wrapper: Covers Run through SSH wrapper across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Grant macOS permissions: Covers Grant macOS permissions across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Probe runtime health: Covers Probe runtime health across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Account setup prompts: Covers setup prompts, policy writes, account merging, default account selection, and account configuration behavior for iMessage/BlueBubbles.
- Account status checks: Covers account status output, setup state, account merging, and default account selection for iMessage/BlueBubbles.
- Doctor repair checks: Covers doctor checks, setup repair prompts, and policy verification for iMessage/BlueBubbles account configuration.
- Account Config: Covers Account Config across setup prompts, policy writes, account merging, default account selection, and related setup, status, doctor, and account config behavior.

Primary docs:

- `docs/announcements/bluebubbles-imessage.md`
- `docs/channels/imessage-from-bluebubbles.md`
- `docs/gateway/config-channels.md`
- `docs/channels/imessage.md`

### 2. Access and Identity

Search anchors: Authorize direct senders, Route direct conversations, Bind ACP sessions, Group Policy, Mentions, System Prompts, imessage / bluebubbles group policy, mentions, and system prompts, group policy, mentions, and system prompts.

Category note: [Access and Identity](dm-pairing-access-and-session-routing.md)

Score decisions:

- Coverage: `Beta (75%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (75%)`
- LTS: ❌

Features:

- Authorize direct senders: Covers Authorize direct senders across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Route direct conversations: Covers Route direct conversations across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Bind ACP sessions: Covers Bind ACP sessions across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Group Policy: Covers Group Policy across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- Mentions: Covers Mentions across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- System Prompts: Covers System Prompts across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.

Primary docs:

- `docs/channels/imessage.md`
- `docs/channels/imessage-from-bluebubbles.md`
- `docs/gateway/config-channels.md`

### 3. Conversation Routing and Delivery

Search anchors: Watch live messages, Coalesce split-send DMs, Replay missed messages, Seed conversation history.

Category note: [Conversation Routing and Delivery](inbound-monitoring-coalescing-catchup-and-history.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (73%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Watch live messages: Covers Watch live messages across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Coalesce split-send DMs: Covers Coalesce split-send DMs across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Replay missed messages: Covers Replay missed messages across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Seed conversation history: Covers Seed conversation history across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.

Primary docs:

- `docs/channels/imessage.md`

### 4. Media and Rich Content

Search anchors: Media, Attachments, Remote Fetch, Chunking, imessage / bluebubbles media, attachments, remote fetch, and chunking, media, attachments, remote fetch, and chunking, Native Actions, Private API, Message Tool, imessage / bluebubbles native actions, private api, and message tool, native actions, private api, and message tool.

Category note: [Media and Rich Content](media-attachments-remote-fetch-and-chunking.md)

Score decisions:

- Coverage: `Beta (73%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (73%)`
- LTS: ❌

Features:

- Media: Covers Media across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Attachments: Covers Attachments across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Remote Fetch: Covers Remote Fetch across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Chunking: Covers Chunking across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Native Actions: Covers Native Actions across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Private API: Covers Private API across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Message Tool: Covers Message Tool across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.

Primary docs:

- `docs/channels/imessage.md`
- `docs/channels/imessage-from-bluebubbles.md`
- `docs/gateway/config-channels.md`

### 5. Native Controls and Approvals

Search anchors: Native Approvals, Reactions, Operator Control, imessage / bluebubbles native approvals, reactions, and operator control, native approvals, reactions, and operator control.

Category note: [Native Controls and Approvals](native-approvals-reactions-and-operator-control.md)

Score decisions:

- Coverage: `Beta (73%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (73%)`
- LTS: ❌

Features:

- Native Approvals: Covers Native Approvals across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.
- Reactions: Covers Reactions across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.
- Operator Control: Covers Operator Control across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.

Primary docs:

- `docs/channels/imessage.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/imessage-bluebubbles/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/imessage-bluebubbles`.
