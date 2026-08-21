---
summary: "Reviewed work-producer evidence for the Arxi host lifecycle seam"
read_when:
  - Updating the OpenClaw version used by Arxi
  - Changing Gateway suspension, cron, tasks, queues, sessions, or terminals
title: "Arxi lifecycle producer inventory"
---

# Arxi lifecycle producer inventory

This is source-level upgrade evidence, not a stable OpenClaw API. Arxi consumes
only the versioned `gateway.suspend.*` protocol. The inventory was reviewed at
upstream merge `cd299e6726b1140d5182f4d3bd1cc4f80c896d16`.

Active work is covered by the canonical Gateway snapshot in
`src/infra/gateway-active-work.ts` plus server-local inspectors in
`src/gateway/server-active-work.ts`:

- command queue and reply delivery;
- embedded agent runs and background exec sessions;
- cron runs, cron-owned watcher work, and registered tasks;
- Gateway root requests, session work admission, and session mutations;
- active or queued chat turns;
- terminal persistence and open terminal sessions.

External ingress reaches one of the root/session/queue/reply boundaries above;
prepared suspension closes that admission before inspection. Cron is the sole
reviewed time-based producer. Its enabled `at`, `every`, and `cron` schedules,
including persisted retry/backoff timestamps, converge on the scheduler's
canonical `nextWakeAtMs`. Event-driven `on-exit`, stream, webhook, channel, and
heartbeat inputs are either active blockers or external events; declarative
heartbeat schedules are cron-owned.

`gateway-lifecycle-inventory.test.ts` compares the declared active categories
with the canonical snapshot and pins the reviewed upstream merge. Any upstream
upgrade therefore fails until this inventory and the wake mapping are reviewed.
