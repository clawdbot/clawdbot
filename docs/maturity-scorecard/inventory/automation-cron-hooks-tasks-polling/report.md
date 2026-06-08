---
title: "Automation: cron, hooks, tasks, polling Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (76%)`
- Quality: `Alpha (69%)`
- Completeness: `Beta (76%)`
- LTS Features: `0/6`

## Summary

This report promotes the archived `automation-cron-hooks-tasks-polling` maturity evidence from `/Users/kevinlin/tmp/maturity/automation-cron-hooks-tasks-polling` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cron Jobs](cron-job-lifecycle.md)                      | ❌  | `Stable (82%)` | `Beta (73%)`  | `Stable (82%)` | Create/edit/remove jobs, Schedule types, Timezone and stagger, Cron RPCs, Agent cron tool, Manual cron runs, Isolated cron execution, Model/provider preflight, Run history, Timeout and denial diagnostics, Chat announce delivery, Webhook delivery, Failure destinations, Skipped-run alerts, Delivery previews              |
| [Event Ingress](channel-polling-webhooks.md)            | ❌  | `Alpha (65%)`  | `Alpha (58%)` | `Alpha (65%)`  | Telegram long polling, Telegram webhook mode, Zalo polling/webhook mode, Polling stall diagnostics, iMessage watch fallback, Gmail setup wizard, Watcher start/serve, Tailscale/public routing, Push token validation, Gmail event routing, POST /hooks/wake, POST /hooks/agent, Mapped hooks, Hook auth policy, Async dispatch |
| [Automation Hooks](internal-hooks.md)                   | ❌  | `Beta (78%)`   | `Beta (72%)`  | `Beta (78%)`   | HOOK.md authoring, Hook discovery, Hook CLI management, Hook packs, Lifecycle event dispatch, api.on registration, Tool-call policy hooks, Message hooks, Session/lifecycle hooks, Plugin approval requests, cron_changed                                                                                                       |
| [Background Tasks and Flows](background-task-ledger.md) | ❌  | `Beta (73%)`   | `Alpha (68%)` | `Beta (73%)`   | Task list/show/cancel, Task notifications, Task audit and maintenance, Chat task board, Task pressure status, Managed flows, Mirrored flows, openclaw tasks flow, Flow audit and maintenance, Plugin managedFlows                                                                                                               |
| [Heartbeat](heartbeat-commitments.md)                   | ❌  | `Stable (82%)` | `Beta (72%)`  | `Stable (82%)` | Heartbeat scheduling, Active hours, Wake and cooldown handling, Due-only heartbeat tasks, Commitment check-ins                                                                                                                                                                                                                  |
| [Polling Controls](message-polls-process-polling.md)    | ❌  | `Beta (74%)`   | `Beta (70%)`  | `Beta (74%)`   | openclaw message poll, Telegram polls, Teams polls, Poll flags, Channel capability gates, process poll, process log, Background process status, No-progress loop detection, Process input controls                                                                                                                              |

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

### 1. Cron Jobs

Search anchors: Create/edit/remove jobs, Schedule types, Timezone and stagger, Cron RPCs, Agent cron tool, openclaw cron, Manual cron runs, Isolated cron execution, Model/provider preflight, Run history, Timeout and denial diagnostics, Chat announce delivery, Webhook delivery, Failure destinations, Skipped-run alerts, Delivery previews, failure destination, announce.

Category note: [Cron Jobs](cron-job-lifecycle.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (73%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Create/edit/remove jobs: Covers Create/edit/remove jobs across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Schedule types: Covers Schedule types across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Timezone and stagger: Covers Timezone and stagger across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Cron RPCs: Covers Cron RPCs across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Agent cron tool: Covers Agent cron tool across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Manual cron runs: Covers Manual cron runs across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Isolated cron execution: Covers Isolated cron execution across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Model/provider preflight: Covers Model/provider preflight across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Run history: Covers Run history across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Timeout and denial diagnostics: Covers Timeout and denial diagnostics across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Chat announce delivery: Covers Chat announce delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Webhook delivery: Covers Webhook delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Failure destinations: Covers Failure destinations across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Skipped-run alerts: Covers Skipped-run alerts across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Delivery previews: Covers Delivery previews across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.

Primary docs:

- `docs/automation/cron-jobs.md`
- `docs/cli/cron.md`
- `docs/gateway/protocol.md`
- `docs/automation/tasks.md`
- `docs/channels/discord.md`

### 2. Event Ingress

Search anchors: Telegram long polling, Telegram webhook mode, Zalo polling/webhook mode, Polling stall diagnostics, iMessage watch fallback, Gmail setup wizard, Watcher start/serve, Tailscale/public routing, Push token validation, Gmail event routing, POST /hooks/wake, POST /hooks/agent, Mapped hooks, Hook auth policy, Async dispatch.

Category note: [Event Ingress](channel-polling-webhooks.md)

Score decisions:

- Coverage: `Alpha (65%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (65%)`
- LTS: ❌

Features:

- Telegram long polling: Covers Telegram long polling across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Telegram webhook mode: Covers Telegram webhook mode across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Zalo polling/webhook mode: Covers Zalo polling/webhook mode across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Polling stall diagnostics: Covers Polling stall diagnostics across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- iMessage watch fallback: Covers iMessage watch fallback across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Gmail setup wizard: Covers Gmail setup wizard across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Watcher start/serve: Covers Watcher start/serve across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Tailscale/public routing: Covers Tailscale/public routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Push token validation: Covers Push token validation across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Gmail event routing: Covers Gmail event routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- POST /hooks/wake: Covers POST /hooks/wake across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- POST /hooks/agent: Covers POST /hooks/agent across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Mapped hooks: Covers Mapped hooks across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Hook auth policy: Covers Hook auth policy across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Async dispatch: Covers Async dispatch across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.

Primary docs:

- `docs/channels/telegram.md`
- `docs/channels/zalo.md`
- `docs/channels/troubleshooting.md`
- `docs/channels/imessage-from-bluebubbles.md`
- `docs/automation/cron-jobs.md#gmail-pubsub-integration`
- `docs/automation/gmail-pubsub.md`
- `docs/cli/webhooks.md`
- `docs/automation/cron-jobs.md#webhooks`
- `docs/automation/webhook.md`

### 3. Automation Hooks

Search anchors: HOOK.md authoring, Hook discovery, Hook CLI management, Hook packs, Lifecycle event dispatch, api.on registration, Tool-call policy hooks, Message hooks, Session/lifecycle hooks, Plugin approval requests, cron_changed.

Category note: [Automation Hooks](internal-hooks.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- HOOK.md authoring: Covers HOOK.md authoring across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook discovery: Covers Hook discovery across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook CLI management: Covers Hook CLI management across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook packs: Covers Hook packs across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Lifecycle event dispatch: Covers Lifecycle event dispatch across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- api.on registration: Covers api.on registration across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Tool-call policy hooks: Covers Tool-call policy hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Message hooks: Covers Message hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Session/lifecycle hooks: Covers Session/lifecycle hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Plugin approval requests: Covers Plugin approval requests across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- cron_changed: Covers cron_changed across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.

Primary docs:

- `docs/automation/hooks.md`
- `docs/cli/hooks.md`
- `docs/plugins/hooks.md`
- `docs/plugins/plugin-permission-requests.md`
- `docs/plugins/sdk-subpaths.md`

### 4. Background Tasks and Flows

Search anchors: Task list/show/cancel, Task notifications, Task audit and maintenance, Chat task board, Task pressure status, Managed flows, Mirrored flows, openclaw tasks flow, Flow audit and maintenance, Plugin managedFlows.

Category note: [Background Tasks and Flows](background-task-ledger.md)

Score decisions:

- Coverage: `Beta (73%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (73%)`
- LTS: ❌

Features:

- Task list/show/cancel: Covers Task list/show/cancel across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task notifications: Covers Task notifications across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task audit and maintenance: Covers Task audit and maintenance across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Chat task board: Covers Chat task board across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task pressure status: Covers Task pressure status across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Managed flows: Covers Managed flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Mirrored flows: Covers Mirrored flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- openclaw tasks flow: Covers openclaw tasks flow across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Flow audit and maintenance: Covers Flow audit and maintenance across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Plugin managedFlows: Covers Plugin managedFlows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.

Primary docs:

- `docs/automation/tasks.md`
- `docs/automation/index.md`
- `docs/cli/tasks.md`
- `docs/automation/taskflow.md`
- `docs/plugins/sdk-runtime.md`

### 5. Heartbeat

Search anchors: Heartbeat scheduling, Active hours, Wake and cooldown handling, Due-only heartbeat tasks, Commitment check-ins, openclaw cron.

Category note: [Heartbeat](heartbeat-commitments.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Heartbeat scheduling: Covers Heartbeat scheduling across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Active hours: Covers Active hours across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Wake and cooldown handling: Covers Wake and cooldown handling across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Due-only heartbeat tasks: Covers Due-only heartbeat tasks across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Commitment check-ins: Covers Commitment check-ins across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.

Primary docs:

- `docs/automation/index.md`
- `docs/gateway/heartbeat.md`
- `docs/concepts/commitments.md`

### 6. Polling Controls

Search anchors: openclaw message poll, Telegram polls, Teams polls, Poll flags, Channel capability gates, process poll, process log, Background process status.

Category note: [Polling Controls](message-polls-process-polling.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- openclaw message poll: Covers openclaw message poll across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Telegram polls: Covers Telegram polls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Teams polls: Covers Teams polls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Poll flags: Covers Poll flags across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Channel capability gates: Covers Channel capability gates across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- process poll: Covers process poll across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- process log: Covers process log across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Background process status: Covers Background process status across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- No-progress loop detection: Covers No-progress loop detection across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Process input controls: Covers Process input controls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.

Primary docs:

- `docs/automation/poll.md`
- `docs/cli/message.md`
- `docs/channels/telegram.md`
- `docs/channels/msteams.md`
- `docs/gateway/background-process.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/automation-cron-hooks-tasks-polling/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/automation-cron-hooks-tasks-polling`.
