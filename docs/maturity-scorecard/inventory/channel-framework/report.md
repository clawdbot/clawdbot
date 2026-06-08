---
title: "Channel framework Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (77%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (77%)`
- LTS Features: `5/8`

## Summary

This report promotes the archived `channel-framework` maturity evidence from `/Users/kevinlin/tmp/maturity/channel-framework` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                              | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Actions Commands and Approvals](channel-actions-commands-and-approvals.md)   | ❌  | `Alpha (68%)`  | `Beta (72%)`  | `Alpha (68%)`  | Channel-native commands, Native command session target, Message actions, Message tool API discovery, Channel-native approval prompts                                                                                                                                                     |
| [Channel Setup](channel-setup.md)                                                     | ✅  | `Stable (84%)` | `Beta (78%)`  | `Stable (84%)` | Supported channel catalog, Channel status taxonomy in channels list, Setup/onboarding flows, Install-on-demand, Setup wizard metadata                                                                                                                                                    |
| [Group Thread and Ambient Room Behavior](group-thread-and-ambient-room-behavior.md)   | ❌  | `Beta (72%)`   | `Alpha (68%)` | `Beta (72%)`   | Group/channel session isolation, Mention-required, Native threads, Broadcast groups, Bot-loop protection                                                                                                                                                                                 |
| [Inbound Access and Identity Gates](inbound-access-and-identity-gates.md)             | ✅  | `Stable (80%)` | `Beta (76%)`  | `Stable (80%)` | DM pairing, Group/channel allowlists, Access group expansion, Mention gating, Sanitized inbound identity/route projections                                                                                                                                                               |
| [Media Attachments and Rich Channel Data](media-attachments-and-rich-channel-data.md) | ❌  | `Alpha (68%)`  | `Beta (70%)`  | `Alpha (68%)`  | Inbound media normalization, Outbound direct text/media sends, Provider-specific channelData, Media roots                                                                                                                                                                                |
| [Outbound Delivery and Reply Pipeline](outbound-delivery-and-reply-pipeline.md)       | ✅  | `Stable (82%)` | `Beta (75%)`  | `Stable (82%)` | Automatic final reply delivery, Durable outbound send orchestration, Reply pipeline transforms, Provider outbound adapter bridge                                                                                                                                                         |
| [Conversation Routing and Delivery](conversation-routing-and-delivery.md)             | ✅  | `Beta (77%)`   | `Beta (71%)`  | `Beta (77%)`   | Inbound conversation routing, Session key construction, Agent selection precedence, Runtime conversation routing, Thread/parent-child placement, Plugin registry resolution, Channel account startup, Whole-channel lifecycle controls, Config/secrets reload interactions, Auto-restart |
| [Status Health and Operator Controls](status-health-and-operator-controls.md)         | ✅  | `Stable (82%)` | `Beta (78%)`  | `Stable (82%)` | channels.status, Channel health policy, Operator CLI controls, Status read-model                                                                                                                                                                                                         |

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

### 1. Channel Actions Commands and Approvals

Search anchors: channel-native commands, message actions, channel-native approval prompts.

Category note: [Channel Actions Commands and Approvals](channel-actions-commands-and-approvals.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Beta (72%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- Channel-native commands: Channel-native commands and command authorization gates
- Native command session target: Native command session target resolution
- Message actions: Message actions, action dispatch, and trusted requester checks
- Message tool API discovery: Message tool API discovery for channel actions
- Channel-native approval prompts: Channel-native approval prompts and plugin/exec approval routing

Primary docs:

- `docs/channels/groups.md`
- `docs/channels/discord.md`
- `docs/channels/googlechat.md`
- `docs/channels/signal.md`
- `docs/channels/matrix.md`

### 2. Channel Setup

Search anchors: channels list, channels setup, setup wizard metadata.

Category note: [Channel Setup](channel-setup.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (84%)`
- LTS: ✅

Features:

- Supported channel catalog: Supported channel catalog and docs index
- Channel status taxonomy in channels list: Channel status taxonomy in channels list, channels status, and setup status output
- Setup/onboarding flows: Setup/onboarding flows, including first-run channel selection and channel account setup
- Install-on-demand: Install-on-demand, downloadable, bundled, official external, local, npm, and ClawHub distinctions
- Setup wizard metadata: Setup wizard metadata and setup-safe plugin entrypoints

Primary docs:

- `docs/channels/index.md`
- `docs/channels/pairing.md`
- `docs/channels/troubleshooting.md`
- `docs/plugins/sdk-channel-plugins.md`

### 3. Group Thread and Ambient Room Behavior

Search anchors: mentionRequired, ambient room events, broadcast groups.

Category note: [Group Thread and Ambient Room Behavior](group-thread-and-ambient-room-behavior.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Group/channel session isolation: Group/channel session isolation and group history context
- Mention-required: Mention-required, always-on, and ambient room-event modes
- Native threads: Native threads, topics, parent-child bindings, and thread spawn behavior
- Broadcast groups: Broadcast groups and multi-agent group routing
- Bot-loop protection: Bot-loop protection for room behavior

Primary docs:

- `docs/channels/groups.md`
- `docs/channels/group-messages.md`
- `docs/channels/ambient-room-events.md`
- `docs/channels/broadcast-groups.md`
- `docs/channels/discord.md`

### 4. Inbound Access and Identity Gates

Search anchors: DM pairing, allowFrom, access groups.

Category note: [Inbound Access and Identity Gates](inbound-access-and-identity-gates.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Beta (76%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- DM pairing: DM pairing and allowFrom sender controls
- Group/channel allowlists: Group/channel allowlists and sender allowlists
- Access group expansion: Access group expansion and sender authorization helpers
- Mention gating: Mention gating, implicit mentions, command bypass, and bot-loop-aware admission
- Sanitized inbound identity/route projections: Sanitized inbound identity/route projections for downstream dispatch

Primary docs:

- `docs/channels/access-groups.md`
- `docs/channels/groups.md`
- `docs/channels/discord.md`
- `docs/channels/line.md`

### 5. Media Attachments and Rich Channel Data

Search anchors: inbound media normalization, channelData, media roots.

Category note: [Media Attachments and Rich Channel Data](media-attachments-and-rich-channel-data.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Beta (70%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- Inbound media normalization: Inbound media normalization, attachment persistence, and history media context
- Outbound direct text/media sends: Outbound direct text/media sends and rich payload adapter support
- Provider-specific channelData: Provider-specific channelData, quick replies, locations, polls, reactions, and voice-note handling
- Media roots: Media roots and file-path safety for channel inbound storage

Primary docs:

- `docs/channels/line.md`
- `docs/channels/signal.md`
- `docs/channels/googlechat.md`
- `docs/channels/matrix.md`
- `docs/channels/discord.md`

### 6. Outbound Delivery and Reply Pipeline

Search anchors: automatic final reply delivery, message tool delivery, typing callbacks.

Category note: [Outbound Delivery and Reply Pipeline](outbound-delivery-and-reply-pipeline.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (75%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Automatic final reply delivery: Automatic final reply delivery and strict message-tool-only visible delivery
- Durable outbound send orchestration: Durable outbound send orchestration, receipts, partial failures, and fallback paths
- Reply pipeline transforms: Reply pipeline transforms, typing callbacks, draft streaming, and status reactions
- Provider outbound adapter bridge: Provider outbound adapter bridge and message capabilities

Primary docs:

- `docs/channels/groups.md`
- `docs/channels/ambient-room-events.md`
- `docs/channels/discord.md`
- `docs/channels/matrix.md`
- `docs/gateway/config-channels.md`

### 7. Conversation Routing and Delivery

Search anchors: channel routing, session key construction, agent binding precedence, channels.start, channels.stop, channel account startup, health restart.

Category note: [Conversation Routing and Delivery](conversation-routing-and-delivery.md)

Score decisions:

- Coverage: `Beta (77%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (77%)`
- LTS: ✅

Features:

- Inbound conversation routing: Inbound and command conversation resolution across sessions, threads, and provider-owned targets.
- Session key construction: Session key construction and session metadata recording
- Agent selection precedence: Agent binding precedence and broadcast group dispatch
- Runtime conversation routing: Runtime conversation bindings and ACP session binding routes
- Thread/parent-child placement: Thread/parent-child placement and provider-owned target normalization
- Plugin registry resolution: Plugin registry resolution and scoped channel runtime creation
- Channel account startup: Channel account startup, shutdown, logout, abort, and manual-stop state
- Whole-channel lifecycle controls: Whole-channel and per-account lifecycle fanout for start, stop, logout, restart, and runtime snapshots.
- Config/secrets reload interactions: Config/secrets reload interactions with channel plugin reload targets
- Auto-restart: Auto-restart, backoff, crash-loop caps, and runtime snapshot reporting

Primary docs:

- `docs/channels/channel-routing.md`
- `docs/channels/groups.md`
- `docs/channels/discord.md`
- `docs/channels/matrix.md`
- `docs/channels/troubleshooting.md`
- `docs/gateway/configuration-reference.md`

### 8. Status Health and Operator Controls

Search anchors: channels status --probe, channel health policy, operator CLI controls.

Category note: [Status Health and Operator Controls](status-health-and-operator-controls.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- channels.status: channels.status, probes, account snapshots, and warnings
- Channel health policy: Channel health policy, health monitor restarts, stale socket detection, cooldowns, and restart caps
- Operator CLI controls: Operator CLI controls for start, stop, logout, status, restart, and troubleshoot
- Status read-model: Status read-model and plugin status snapshots

Primary docs:

- `docs/gateway/health.md`
- `docs/gateway/configuration-reference.md`
- `docs/channels/troubleshooting.md`
- `docs/channels/discord.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/channel-framework/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/channel-framework`.
