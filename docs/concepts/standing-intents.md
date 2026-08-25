---
summary: "Remember event-conditioned future actions without relying on long conversational context"
title: "Standing intents"
read_when:
  - You want the agent to act when a future event appears
  - You are choosing between a scheduled task and an event trigger
  - You want to inspect or cancel a standing intent
---

A standing intent is an event-conditioned instruction such as "when the release candidate is mentioned, remind me to verify rollback ownership." OpenClaw stores it in the owning agent's SQLite database and checks it before eligible interactive replies.

Standing intents are prospective memory. They remember what to do when a trigger appears; they do not schedule work for a clock time.

## Choose the right intention tier

| Intention   | Use                                      | Example                                              |
| ----------- | ---------------------------------------- | ---------------------------------------------------- |
| Time-based  | [Scheduled tasks](/automation/cron-jobs) | "Remind me Friday at 9 AM"                           |
| Event-based | Standing intent                          | "When Alice mentions the launch, ask about rollback" |
| Aspiration  | Markdown with a review date              | "Improve the release checklist this quarter"         |

Put aspirations in `MEMORY.md`, a project note, or another maintained Markdown file with an explicit review date. They are neither clock jobs nor event triggers.

## Create an event-based intent

Standing intents are owner-directed memory. Channel owners recognized by
`commands.ownerAllowFrom` can use the `intent` tool to create, list, or cancel
them; other senders do not receive that tool. Authenticated Gateway/Control UI
administrators and the local CLI can inspect and cancel existing intents, but
creation requires an authenticated channel and sender identity. If either is
missing, OpenClaw refuses creation and asks the operator to retry from an
authenticated channel conversation.

Ask the agent to create the intent and name the event clearly:

```text
When someone mentions the launch checklist, remind me to confirm the rollback owner.
```

The agent uses the `intent` tool with a description and trigger keywords. It can also narrow the intent to one conversation channel identifier or sender identifier, set an expiry, reduce or increase the fire budget, or change the cooldown.

The default scope is the current channel and sender. An explicit `anywhere` or
`anyone` scope still requires the creating sender identity: the matching hook
cannot safely enforce a senderless owner principal on later channel turns.

Defaults are intentionally conservative:

- cooldown: 24 hours
- maximum fires: 3
- expiry: 90 days

For a clock time, the agent should use the existing scheduled-task path instead of creating a standing intent.

## How matching works

On an eligible user turn, OpenClaw performs a deterministic FTS keyword prefilter over armed intents. A candidate fires only when every term in at least one configured trigger entry appears in the turn. OpenClaw also rechecks channel scope, sender scope, expiry, cooldown, and fire budget against the authoritative SQLite rows in one synchronous transaction. Matching scans at most 256 scoped FTS candidates per turn so a noisy trigger set cannot stall the reply path.

No model call occurs in the matching path. On a hit, the main reply receives a bounded hidden context block:

```text
Standing intent (created 2026-07-27): Confirm the rollback owner.
```

The matcher increments `fire_count`, records `last_fired_at`, and moves the intent through its explicit lifecycle. A fired intent becomes armed again only after its cooldown. It becomes `done` when its fire budget is exhausted and `expired` when its expiry passes. Expiry and cooldown maintenance also piggyback on existing heartbeat and cron reply hooks; OpenClaw does not add another timer subsystem.

TriggerBench finds that prospective recall decays as context grows and can drift into an always-remind heuristic ([arXiv:2606.23459](https://arxiv.org/abs/2606.23459)). Structural matching and fire budgets keep recall independent of conversational context while bounding false alarms.

## List and cancel

Ask the agent to list standing intents when you want to inspect their status, scope, expiry, or fire count.

Cancellation is always explicit. Ask the agent to cancel a specific intent; the stored row moves to `cancelled` and can no longer fire. OpenClaw never infers cancellation from ordinary conversation. ProEvent reports that proactive systems frequently overact and struggle with event cancellation ([arXiv:2607.17701](https://arxiv.org/abs/2607.17701)), so cancellation is durable state rather than a model judgment.

## Lifecycle states

| State       | Meaning                          |
| ----------- | -------------------------------- |
| `pending`   | Stored but not yet armed         |
| `armed`     | Eligible for matching            |
| `fired`     | Matched and waiting for cooldown |
| `done`      | Fire budget exhausted            |
| `cancelled` | Explicitly cancelled             |
| `expired`   | Expiry reached                   |

Standing intents live in `agents/<agentId>/agent/openclaw-agent.sqlite`. They add no configuration keys and create no sidecar files.

## Related

- [Memory overview](/concepts/memory)
- [User model](/concepts/user-model)
- [Scheduled tasks](/automation/cron-jobs)
