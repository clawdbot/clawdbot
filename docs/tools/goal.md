---
doc-schema-version: 1
summary: "Session goals: durable per-session objectives, /goal controls, model goal tools, token budgets, and TUI status"
read_when:
  - You want OpenClaw to keep one objective visible across a long session
  - You need to pause, resume, block, complete, or clear a session goal
  - You want to understand the get_goal, create_goal, and update_goal tools
  - You want to see how goals appear in the TUI
title: "Goal"
---

# Goal

A **goal** is one durable objective attached to the current OpenClaw session.
It gives the agent and the operator a shared target for long-running work,
without turning that target into a background task, reminder, cron job, or
standing order.

Goals are session state. They move with the session key, survive process
restarts, show up in `/goal`, are available to the model through the goal
tools, and appear in the TUI footer when the active session has one.

## Quick start

Set a goal:

```text
/goal start get CI green for PR 87469 and push the fix
```

Check it:

```text
/goal
```

Pause it when work is intentionally waiting:

```text
/goal pause waiting for CI
```

Resume it:

```text
/goal resume
```

Mark it complete:

```text
/goal complete pushed and verified
```

Clear it:

```text
/goal clear
```

## What goals are for

Use a goal when a session has a concrete outcome that should remain visible
across many turns:

- A PR closeout: fix, verify, autoreview, push, and open or update the PR.
- A debug run: reproduce the bug, identify the owning surface, patch, and prove
  the fix.
- A docs pass: read the relevant docs, write the new page, cross-link it, and
  verify the docs build.
- A maintenance task: inspect current state, make bounded changes, run the right
  checks, and report what changed.

A goal is not a task queue. Use [Task Flow](/automation/taskflow),
[tasks](/automation/tasks), [cron jobs](/automation/cron-jobs), or
[standing orders](/automation/standing-orders) when work should run detached,
repeat on a schedule, fan out into managed sub-work, or persist as a policy.

## Command reference

`/goal` without arguments prints the current goal summary:

```text
Goal
Status: active
Objective: get CI green for PR 87469 and push the fix
Tokens used: 12k
Token budget: 12k/50k

Commands: /goal pause, /goal complete, /goal clear
```

Commands:

- `/goal` or `/goal status` shows the current goal.
- `/goal start <objective>` creates a new goal for the current session.
- `/goal set <objective>` and `/goal create <objective>` are aliases for
  `start`.
- `/goal pause [note]` pauses an active goal.
- `/goal resume [note]` resumes a paused, blocked, usage-limited, or
  budget-limited goal.
- `/goal complete [note]` marks the goal achieved.
- `/goal done [note]` is an alias for `complete`.
- `/goal block [note]` marks the goal blocked.
- `/goal blocked [note]` is an alias for `block`.
- `/goal clear` removes the goal from the session.

Only one goal can exist on a session at a time. Starting a second goal fails
until the current one is cleared.

## Statuses

Goals use a small status set:

- `active`: the session is pursuing the goal.
- `paused`: the operator paused the goal; `/goal resume` makes it active again.
- `blocked`: the agent or operator reported a real blocker; `/goal resume`
  makes it active again when new information or state is available.
- `budget_limited`: the configured token budget was reached; `/goal resume`
  restarts pursuit from the same objective.
- `usage_limited`: reserved for usage-limit stop states; `/goal resume`
  restarts pursuit when allowed.
- `complete`: the goal was achieved. Complete goals are terminal; use
  `/goal clear` before starting another goal.

`/new` and `/reset` clear the current session goal because they intentionally
start fresh session context.

## Token budgets

Goals can have an optional positive token budget. The budget is stored with the
goal and measured from the session's fresh token count at creation time. If the
current session only has stale or unknown token usage when the goal starts,
OpenClaw waits for the next fresh session token snapshot and uses that as the
baseline, so tokens spent before the goal existed are not charged to the goal.

When token usage reaches the budget, the goal changes to `budget_limited`. This
does not delete the goal or erase the objective. It tells the operator and the
agent that the goal is no longer actively being pursued until it is resumed or
cleared.

Token budgets are a session-goal guardrail, not a billing cap. Provider quota,
cost reporting, and context-window behavior still use the normal OpenClaw
usage and model controls.

## Model tools

OpenClaw exposes three core goal tools to agent harnesses:

- `get_goal`: read the current session goal, including status, objective, token
  usage, and token budget.
- `create_goal`: create a goal only when the user, system, or developer
  instructions explicitly request one. It fails if the session already has a
  goal.
- `update_goal`: mark the goal `complete` or `blocked`.

The model cannot silently pause, resume, clear, or replace a goal. Those are
operator/session controls through `/goal` and reset commands. This keeps the
agent from quietly moving the target while preserving a clean path for the
agent to report achievement or a genuine blocker.

The `update_goal` tool should mark a goal `complete` only when the objective is
actually achieved. It should mark a goal `blocked` only when the same blocking
condition has repeated and the agent cannot make meaningful progress without
new user input or an external-state change.

## TUI

The TUI keeps the active session's goal visible in the footer next to the
agent, session, model, run controls, and token counts.

Footer examples:

- `Pursuing goal (12k/50k)` for an active goal with a token budget.
- `Goal paused (/goal resume)` for a paused goal.
- `Goal blocked (/goal resume)` for a blocked goal.
- `Goal hit usage limits (/goal resume)` for a usage-limited goal.
- `Goal unmet (50k/50k)` for a budget-limited goal.
- `Goal achieved (42k)` for a completed goal.

The footer is intentionally compact. Use `/goal` for the full objective, note,
token budget, and available commands.

## Channel behavior

The `/goal` command works in command-capable OpenClaw sessions, including the
TUI and chat surfaces that permit text commands. Goal state is attached to the
session key, not the transport. If two surfaces use the same session, they see
the same goal.

Goal state is not a delivery directive. It does not force replies through a
channel, change queue behavior, approve tools, or schedule work.

## Troubleshooting

`Goal error: goal already exists` means the session already has a goal. Use
`/goal` to inspect it, `/goal complete` if it is done, or `/goal clear` before
starting a different objective.

`Goal error: goal not found` means the session has no goal yet. Start one with
`/goal start <objective>`.

`Goal error: goal is already complete` means the goal is terminal. Clear it
before starting or resuming another objective.

If token usage looks like `0` or stale, the active session may not have a fresh
token snapshot yet. Usage refreshes as OpenClaw records session usage and
transcript-derived totals.

## Related

- [Slash commands](/tools/slash-commands)
- [TUI](/web/tui)
- [Session tool](/concepts/session-tool)
- [Compaction](/concepts/compaction)
- [Task Flow](/automation/taskflow)
- [Standing orders](/automation/standing-orders)
