# Automation: cron, hooks, tasks, polling Completeness

Use this rubric when assigning category Completeness scores for the
`automation-cron-hooks-tasks-polling` surface.

## Category Scope

- Cron Jobs: Create/edit/remove jobs, Schedule types, Timezone and stagger, Cron RPCs, Agent cron tool, Manual cron runs, Isolated cron execution, Model/provider preflight, Run history, Timeout and denial diagnostics, Chat announce delivery, Webhook delivery, Failure destinations, Skipped-run alerts, Delivery previews
- Event Ingress: Telegram long polling, Telegram webhook mode, Zalo polling/webhook mode, Polling stall diagnostics, iMessage watch fallback, Gmail setup wizard, Watcher start/serve, Tailscale/public routing, Push token validation, Gmail event routing, POST /hooks/wake, POST /hooks/agent, Mapped hooks, Hook auth policy, Async dispatch
- Automation Hooks: HOOK.md authoring, Hook discovery, Hook CLI management, Hook packs, Lifecycle event dispatch, api.on registration, Tool-call policy hooks, Message hooks, Session/lifecycle hooks, Plugin approval requests, cron_changed
- Background Tasks and Flows: Task list/show/cancel, Task notifications, Task audit and maintenance, Chat task board, Task pressure status, Managed flows, Mirrored flows, openclaw tasks flow, Flow audit and maintenance, Plugin managedFlows
- Heartbeat: Heartbeat scheduling, Active hours, Wake and cooldown handling, Due-only heartbeat tasks, Commitment check-ins
- Polling Controls: openclaw message poll, Telegram polls, Teams polls, Poll flags, Channel capability gates, process poll, process log, Background process status, No-progress loop detection, Process input controls
