---
title: "Telegram Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (75%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (75%)`
- LTS Features: `5/5`

## Summary

This report promotes the archived `telegram` maturity evidence from `/Users/kevinlin/tmp/maturity/telegram` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                      | LTS | Coverage     | Quality       | Completeness | Features to evaluate                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | --- | ------------ | ------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channel Setup and Operations](bot-setup-and-account-configuration.md)        | ✅  | `Beta (76%)` | `Beta (70%)`  | `Beta (76%)` | BotFather token creation, TELEGRAM_BOT_TOKEN, Setup wizard credential capture, Startup getMe, Doctor/status surfacing, Named account configuration, CLI/message-tool targets, Directory adapters, Channel status, Account-scoped outbound      |
| [Access and Identity](dm-pairing-and-sender-authorization.md)                 | ✅  | `Beta (76%)` | `Alpha (68%)` | `Beta (76%)` | dmPolicy modes, Pairing-code approval, Numeric Telegram user ID normalization with telegram, allowFrom, Unauthorized DM, Group allowlists, Supergroup negative chat IDs, Forum topic session keys, ACP topic routing, Session key construction |
| [Conversation Routing and Delivery](group-forum-topic-and-session-routing.md) | ✅  | `Beta (74%)` | `Alpha (68%)` | `Beta (74%)` | Conversation Routing and Delivery                                                                                                                                                                                                              |
| [Media and Rich Content](media-location-polls-and-rich-inputs.md)             | ✅  | `Beta (74%)` | `Beta (72%)`  | `Beta (74%)` | Media and Rich Content                                                                                                                                                                                                                         |
| [Native Controls and Approvals](inline-buttons-approvals-and-actions.md)      | ✅  | `Beta (74%)` | `Beta (72%)`  | `Beta (74%)` | Inline keyboard rendering, Exec approvals in DMs, Message actions, Action capability discovery, Native setMyCommands startup sync, Command name/description normalization, Built-in commands, Command authorization in DMs, Model buttons      |

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

Search anchors: telegram bot setup and account configuration, bot setup and account configuration, telegram multi account cli targets and status, multi account cli targets and status.

Category note: [Channel Setup and Operations](bot-setup-and-account-configuration.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ✅

Features:

- BotFather token creation: BotFather token creation and first gateway start
- TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN, botToken, tokenFile, and account-scoped token
- Setup wizard credential capture: Setup wizard credential capture, allowlist prompts, and DM policy defaults
- Startup getMe: Startup getMe, bot-info cache, account throttling, and multi-account default
- Doctor/status surfacing: Doctor/status surfacing for invalid tokens, missing defaults, and read-only
- Named account configuration: Named account configuration, default account selection, account-local group
- CLI/message-tool targets: numeric chat IDs, usernames, forum-topic
- Directory adapters: Directory adapters and configured peers/groups for user-facing target lists
- Channel status: Channel status, channels status --probe, token source summaries, liveness
- Account-scoped outbound: Account-scoped outbound, poll, media, and approval target resolution

Primary docs:

- `docs/channels/telegram.md`
- `docs/gateway/config-channels.md`
- `docs/cli/channels.md`

### 2. Access and Identity

Search anchors: telegram dm pairing and sender authorization, dm pairing and sender authorization, telegram group forum topic and session routing, group forum topic and session routing.

Category note: [Access and Identity](dm-pairing-and-sender-authorization.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (76%)`
- LTS: ✅

Features:

- dmPolicy modes: pairing, allowlist, open, and disabled
- Pairing-code approval: Pairing-code approval, first-owner bootstrap, and commands.ownerAllowFrom
- Numeric Telegram user ID normalization with telegram: and tg: prefixes
- allowFrom: allowFrom, groupAllowFrom, access groups, and DM-versus-group boundaries
- Unauthorized DM: Unauthorized DM, group, command, callback, and reaction handling
- Group allowlists: Group allowlists, groupPolicy, groupAllowFrom, and mention gating
- Supergroup negative chat IDs: Supergroup negative chat IDs and group/topic config inheritance
- Forum topic session keys: Forum topic session keys, message_thread_id, General topic behavior, and topic routing.
- ACP topic routing: ACP topic binding and /acp spawn --thread
- Session key construction: Session key construction, conversation route matching, and reply target

Primary docs:

- `docs/channels/telegram.md`
- `docs/channels/pairing.md`
- `docs/channels/access-groups.md`
- `docs/channels/groups.md`
- `docs/concepts/multi-agent.md`

### 3. Conversation Routing and Delivery

Search anchors: telegram conversation routing and delivery, conversation routing and delivery.

Category note: [Conversation Routing and Delivery](group-forum-topic-and-session-routing.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

Primary docs:

- `docs/channels/telegram.md`
- `docs/channels/groups.md`
- `docs/concepts/multi-agent.md`

### 4. Media and Rich Content

Search anchors: telegram media and rich content, media and rich content.

Category note: [Media and Rich Content](media-location-polls-and-rich-inputs.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Media and Rich Content: Evidence scope for Media and Rich Content.

Primary docs:

- `docs/channels/telegram.md`
- `docs/channels/location.md`

### 5. Native Controls and Approvals

Search anchors: telegram inline buttons approvals and actions, inline buttons approvals and actions, telegram native commands and command ui, native commands and command ui.

Category note: [Native Controls and Approvals](inline-buttons-approvals-and-actions.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Inline keyboard rendering: Inline keyboard rendering, callback query handling, Mini App URL buttons, and approval callbacks.
- Exec approvals in DMs: Exec approvals in DMs, channels, topics, or both; approver resolution; plugin
- Message actions: send, poll, react, delete, edit, sticker, and sticker search actions.
- Action capability discovery: Action capability discovery, gating config, account-scoped action gates, and requester trust checks.
- Native setMyCommands startup sync: Native setMyCommands startup sync, custom commands, native aliases, plugin
- Command name/description normalization: Command name/description normalization, menu budget trimming, duplicate
- Built-in commands: Built-in commands such as /help, /commands, /whoami, /status, and related command UI.
- Command authorization in DMs: Command authorization in DMs, groups, and commands addressed to other bots
- Model buttons: Model buttons and command UI helpers

Primary docs:

- `docs/channels/telegram.md`
- `docs/tools/exec-approvals.md`
- `docs/tools/reactions.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/telegram/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/telegram`.
