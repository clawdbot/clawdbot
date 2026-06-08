---
title: "Discord Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (71%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (71%)`
- LTS Features: `4/6`

## Summary

This report promotes the archived `discord` maturity evidence from `/Users/kevinlin/tmp/maturity/discord` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                       | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Channel Setup and Operations](bot-setup-and-account-configuration.md)                         | ✅  | `Beta (74%)`  | `Beta (71%)`  | `Beta (74%)`  | Application and bot setup, Token and application ID configuration, Setup wizard and account inspection, Status, doctor, and intent checks, Multi-account bot configuration, Account monitor startup, Gateway WebSocket lifecycle, Reconnect and heartbeat handling, Rate limits and gateway metadata, Status, probe, and health-monitor recovery |
| [Access and Identity](dm-pairing-and-sender-authorization.md)                                  | ✅  | `Beta (74%)`  | `Beta (72%)`  | `Beta (74%)`  | DM policy modes, Allowlist inheritance, Pairing-code approval, Sender authorization, Access-group authorization, Group DM authorization                                                                                                                                                                                                          |
| [Conversation Routing and Delivery](guild-channel-routing-and-session-isolation.md)            | ✅  | `Beta (74%)`  | `Beta (72%)`  | `Beta (74%)`  | Guild and channel admission, Mention gating, Session key isolation, Configured and runtime routing, Inbound context visibility, Forum and media-channel thread posts, Thread actions, Target parsing, Thread context resolution, Thread-bound session routing, ACP agent routing, Routing lifecycle                                              |
| [Media and Rich Content](media-attachments-and-voice-message-handling.md)                      | ✅  | `Beta (74%)`  | `Beta (72%)`  | `Beta (74%)`  | Media and Rich Content                                                                                                                                                                                                                                                                                                                           |
| [Native Controls and Approvals](native-slash-commands-components-and-interactive-callbacks.md) | ❌  | `Alpha (58%)` | `Beta (72%)`  | `Alpha (58%)` | Native slash command registration, Native slash command execution, Model Picker Commands, Components v2 messages, Callback TTL                                                                                                                                                                                                                   |
| [Realtime Voice and Calls](realtime-discord-voice-channels.md)                                 | ❌  | `Beta (74%)`  | `Alpha (66%)` | `Beta (74%)`  | Voice Channel Lifecycle, Auto-join and follow-users, Realtime voice modes, Wake, barge-in, and echo handling, Voice codec and DAVE recovery                                                                                                                                                                                                      |

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

Search anchors: Application and bot setup, Token and application ID configuration, Setup wizard and account inspection, Status, doctor, and intent checks, Multi-account bot configuration, Account monitor startup, Gateway WebSocket lifecycle, Reconnect and heartbeat handling, Rate limits and gateway metadata, Status, probe, and health-monitor recovery.

Category note: [Channel Setup and Operations](bot-setup-and-account-configuration.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Application and bot setup: Covers Application and bot setup across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Token and application ID configuration: Covers Token and application ID configuration across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Setup wizard and account inspection: Covers Setup wizard and account inspection across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Status, doctor, and intent checks: Covers Status, doctor, and intent checks across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Multi-account bot configuration: Covers Multi-account bot configuration across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Account monitor startup: Covers Account monitor startup across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Gateway WebSocket lifecycle: Covers Gateway WebSocket lifecycle across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Reconnect and heartbeat handling: Covers Reconnect and heartbeat handling across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Rate limits and gateway metadata: Covers Rate limits and gateway metadata across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Status, probe, and health-monitor recovery: Covers Status, probe, and health-monitor recovery across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.

Primary docs:

- `docs/channels/discord.md`
- `docs/plugins/reference/discord.md`
- `docs/install/fly.md`
- `docs/tools/slash-commands.md`
- `docs/gateway/health.md`
- `docs/cli/channels.md`
- `docs/gateway/config-channels.md`

### 2. Access and Identity

Search anchors: DM policy modes, Allowlist inheritance, Pairing-code approval, Sender authorization, Access-group authorization, Group DM authorization.

Category note: [Access and Identity](dm-pairing-and-sender-authorization.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- DM policy modes: Covers DM policy modes across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Allowlist inheritance: Covers Allowlist inheritance across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Pairing-code approval: Covers Pairing-code approval across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Sender authorization: Covers Sender authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Access-group authorization: Covers Access-group authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Group DM authorization: Covers Group DM authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.

Primary docs:

- `docs/channels/discord.md`
- `docs/channels/pairing.md`
- `docs/channels/access-groups.md`
- `docs/channels/groups.md`

### 3. Conversation Routing and Delivery

Search anchors: Guild and channel admission, Mention gating, Session key isolation, Configured and runtime bindings, Inbound context visibility, Forum and media-channel thread posts, Thread actions, Target parsing, Thread context resolution, Thread-bound session routing, ACP bindings, Binding lifecycle.

Category note: [Conversation Routing and Delivery](guild-channel-routing-and-session-isolation.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Guild and channel admission: Covers Guild and channel admission across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Mention gating: Covers Mention gating across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Session key isolation: Covers Session key isolation across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Configured and runtime routing: Covers Configured and runtime bindings across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Inbound context visibility: Covers Inbound context visibility across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Forum and media-channel thread posts: Covers Forum and media-channel thread posts across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread actions: Covers Thread actions across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Target parsing: Covers Target parsing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread context resolution: Covers Thread context resolution across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread-bound session routing: Covers Thread-bound session routing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- ACP agent routing: Covers ACP bindings across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Routing lifecycle: Covers Binding lifecycle across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.

Primary docs:

- `docs/channels/discord.md`
- `docs/channels/channel-routing.md`
- `docs/channels/groups.md`
- `docs/channels/access-groups.md`
- `docs/tools/acp-agents.md`
- `docs/tools/subagents.md`

### 4. Media and Rich Content

Search anchors: discord media and rich content, media and rich content.

Category note: [Media and Rich Content](media-attachments-and-voice-message-handling.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Media and Rich Content: Evidence scope for Media and Rich Content.

Primary docs:

- `docs/channels/discord.md`

### 5. Native Controls and Approvals

Search anchors: discord native slash commands, components, and interactive callbacks, native slash commands, components, and interactive callbacks.

Category note: [Native Controls and Approvals](native-slash-commands-components-and-interactive-callbacks.md)

Score decisions:

- Coverage: `Alpha (58%)`
- Quality: `Beta (72%)`
- Completeness: `Alpha (58%)`
- LTS: ❌

Features:

- Native slash command registration: Native slash command registration and reconciliation for Discord application commands
- Native slash command execution: Native slash command execution, autocomplete, authz, and interaction dispatch
- Model Picker Commands: Covers Model Picker Commands across Native slash command registration and reconciliation for Discord application commands. Native slash command execution, autocomplete, authz, and interaction dispatch. `/model` and `/models` picker flows, and related native slash commands, components, and interactive callbacks behavior.
- Components v2 messages: Components v2 messages, buttons, string/user/role/mentionable/channel selects, modal triggers, and modal submits
- Callback TTL: Callback TTL, reusable versus single-use callbacks, persistent callback registry entries, allowedUsers, guild/DM/group authz, and plugin interactive callback dispatch

Primary docs:

- `docs/channels/discord.md`
- `docs/tools/slash-commands.md`

### 6. Realtime Voice and Calls

Search anchors: /vc lifecycle, Auto-join and follow-users, Realtime voice modes, Wake, barge-in, and echo handling, Voice codec and DAVE recovery.

Category note: [Realtime Voice and Calls](realtime-discord-voice-channels.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Voice Channel Lifecycle: Covers Voice Channel Lifecycle across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Auto-join and follow-users: Covers Auto-join and follow-users across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Realtime voice modes: Covers Realtime voice modes across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Wake, barge-in, and echo handling: Covers Wake, barge-in, and echo handling across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Voice codec and DAVE recovery: Covers Voice codec and DAVE recovery across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.

Primary docs:

- `docs/channels/discord.md`
- `docs/providers/openai.md`
- `docs/providers/elevenlabs.md`
- `docs/concepts/qa-e2e-automation.md`
- `docs/gateway/config-channels.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/discord/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/discord`.
