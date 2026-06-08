---
title: "Slack Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (70%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (70%)`
- LTS Features: `5/5`

## Summary

This report promotes the archived `slack` maturity evidence from `/Users/kevinlin/tmp/maturity/slack` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                             | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                               |
| ------------------------------------------------------------------------------------ | --- | ------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Channel Setup and Operations](app-install-auth-manifest-and-scopes.md)              | ✅  | `Beta (74%)`  | `Alpha (68%)` | `Beta (74%)`  | App Install, Slack app credentials, Manifest, Scopes, Channel status diagnostics, Slack account status, Operator Repair, Socket, HTTP transport, Runtime Lifecycle |
| [Access and Identity](dm-pairing-and-sender-authorization.md)                        | ✅  | `Beta (74%)`  | `Beta (70%)`  | `Beta (74%)`  | Access and Identity                                                                                                                                                |
| [Conversation Routing and Delivery](channel-thread-routing-and-session-isolation.md) | ✅  | `Alpha (64%)` | `Alpha (66%)` | `Alpha (64%)` | Channel allowlists, Thread routing, Session Isolation, DM Pairing, Sender Authorization                                                                            |
| [Media and Rich Content](media-attachments-files-and-vision.md)                      | ✅  | `Alpha (64%)` | `Alpha (66%)` | `Alpha (64%)` | Media and Rich Content                                                                                                                                             |
| [Native Controls and Approvals](slash-commands-and-native-command-routing.md)        | ✅  | `Beta (72%)`  | `Beta (70%)`  | `Beta (72%)`  | Slash Commands, Native Command Routing, Interactive Replies, App Home, Assistant Events, Native Approvals, Actions, Security-sensitive Ops                         |

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

Search anchors: App Install, bot token, signing secret, Manifest, Scopes, recommended manifest, minimal manifest, openclaw channels status --probe, capability and scope diagnostics, account snapshots, Operator Repair, slack diagnostics, status, and operator repair, diagnostics, status, and operator repair, Socket, HTTP Request URL, Runtime Lifecycle, slack socket/http transport and runtime lifecycle, socket/http transport and runtime lifecycle.

Category note: [Channel Setup and Operations](app-install-auth-manifest-and-scopes.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- App Install: Covers App Install across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Slack app credentials: Covers bot/app/user tokens, signing-secret handling, and Slack credential setup for app authentication.
- Manifest: Covers Manifest across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Scopes: Covers Scopes across installing `@openclaw/slack`, creating the Slack app, choosing recommended/minimal manifests, bot/app/user/signing-secret credential handling, and related app install, auth, manifest, and scopes behavior.
- Channel status diagnostics: Covers `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and Slack repair guidance.
- Slack account status: Covers account snapshots, token source/status fields, capability summaries, and Slack status output.
- Operator Repair: Covers Operator Repair across `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and related diagnostics, status, and operator repair behavior.
- Socket: Covers Socket across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.
- HTTP transport: Covers HTTP Request URL registration, signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and Slack HTTP runtime startup/skip behavior.
- Runtime Lifecycle: Covers Runtime Lifecycle across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.

Primary docs:

- `docs/channels/slack.md`
- `docs/plugins/reference/slack.md`
- `docs/gateway/secrets.md`
- `docs/concepts/qa-e2e-automation.md`
- `docs/channels/troubleshooting.md`

### 2. Access and Identity

Search anchors: slack access and identity, access and identity.

Category note: [Access and Identity](dm-pairing-and-sender-authorization.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Access and Identity: Evidence scope for Access and Identity.

Primary docs:

- `docs/channels/slack.md`
- `docs/channels/pairing.md`

### 3. Conversation Routing and Delivery

Search anchors: channel allowlists, Thread routing, Session Isolation, groupPolicy, subteam mention, DM Pairing, Sender Authorization, slack dm pairing and sender authorization, dm pairing and sender authorization.

Category note: [Conversation Routing and Delivery](channel-thread-routing-and-session-isolation.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (66%)`
- Completeness: `Alpha (64%)`
- LTS: ✅

Features:

- Channel allowlists: Covers channel allowlists, `groupPolicy`, channel/user gates, mention gates, and subteam mention behavior.
- Thread routing: Covers Slack thread routing, thread-aware reply targeting, and session binding for channel threads.
- Session Isolation: Covers Session Isolation across channel allowlists, `groupPolicy`, channel/user gates, mention and subteam mention behavior, and related channel/thread routing and session isolation behavior.
- DM Pairing: Covers DM Pairing across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.
- Sender Authorization: Covers Sender Authorization across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.

Primary docs:

- `docs/channels/slack.md`
- `docs/channels/bot-loop-protection.md`
- `docs/channels/pairing.md`

### 4. Media and Rich Content

Search anchors: slack media and rich content, media and rich content.

Category note: [Media and Rich Content](media-attachments-files-and-vision.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (66%)`
- Completeness: `Alpha (64%)`
- LTS: ✅

Features:

- Media and Rich Content: Evidence scope for Media and Rich Content.

Primary docs:

- `docs/channels/slack.md`
- `docs/concepts/qa-e2e-automation.md`

### 5. Native Controls and Approvals

Search anchors: Slash Commands, Native Command Routing, slack slash commands and native command routing, slash commands and native command routing, Interactive Replies, App Home, Assistant Events, slack interactive replies, app home, and assistant events, interactive replies, app home, and assistant events, Native Approvals, Actions, Security-sensitive Ops, slack native approvals, actions, and security-sensitive ops, native approvals, actions, and security-sensitive ops.

Category note: [Native Controls and Approvals](slash-commands-and-native-command-routing.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (72%)`
- LTS: ✅

Features:

- Slash Commands: Covers Slash Commands across configured slash command mode, native slash commands, command registration expectations, session keys, and related slash commands and native command routing behavior.
- Native Command Routing: Covers Native Command Routing across configured slash command mode, native slash commands, command registration expectations, session keys, and related slash commands and native command routing behavior.
- Interactive Replies: Covers Interactive Replies across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- App Home: Covers App Home across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- Assistant Events: Covers Assistant Events across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- Native Approvals: Covers Native Approvals across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Actions: Covers Actions across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Security-sensitive Ops: Covers Security-sensitive Ops across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.

Primary docs:

- `docs/channels/slack.md`
- `docs/tools/slash-commands.md`
- `docs/tools/exec-approvals.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/slack/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/slack`.
