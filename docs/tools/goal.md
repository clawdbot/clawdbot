---
doc-schema-version: 1
summary: "Session goals: durable per-session objectives, /goal controls, model goal tools, token budgets, and TUI status"
read_when:
  - You want OpenClaw to keep one objective visible across a long session
  - You need to pause, resume, block, complete, or clear a session goal
  - You want to understand the get_goal, create_goal, and update_goal tools
  - You want to use the Goal composer in the Control UI or see goals in the TUI
title: "Goal"
---

# Goal

A **goal** is one durable objective attached to the current OpenClaw session.
It gives the agent and the operator a shared target for long-running work,
without turning that target into a background task, reminder, cron job, or
standing order.

Goals are session state: they move with the session key, survive process
restarts, and appear in `/goal`, the model-facing goal tools, and the TUI
footer.

Detached command completions return to the originating user-facing thread, so
the next turn continues to see the same goal even when command execution used
a separate sandbox policy session.

## Quick start

```text
/goal start get CI green for PR 87469 and push the fix
/goal
/goal edit get CI green for PR 87469, push the fix, and update docs
/goal pause waiting for CI
/goal resume
/goal complete pushed and verified
/goal clear
```

`start` is optional: `/goal get CI green for PR 87469` also creates a goal,
since any text after `/goal` that is not a known action word is treated as a
new objective.

## What goals are for

Use a goal when a session has a concrete outcome that should stay visible
across many turns:

- A PR closeout: fix, verify, autoreview, push, and open or update the PR.
- A debug run: reproduce the bug, identify the owning surface, patch, and
  prove the fix.
- A docs pass: read the relevant docs, write the new page, cross-link it, and
  verify the docs build.
- A maintenance task: inspect current state, make bounded changes, run the
  right checks, and report what changed.

A goal is not a task queue. Use [Task Flow](/automation/taskflow),
[tasks](/automation/tasks), [cron jobs](/automation/cron-jobs), or
[standing orders](/automation/standing-orders) when work should run detached,
repeat on a schedule, fan out into managed sub-work, or persist as a policy.

## Command reference

`/goal` with no arguments prints the current goal summary:

```text
Goal
Status: active
Objective: get CI green for PR 87469 and push the fix
Tokens used: 12k
Token budget: 12k/50k

Commands: /goal edit <objective>, /goal pause, /goal complete, /goal clear
```

| Command                                             | Effect                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `/goal` or `/goal status`                           | Show the current goal.                                                   |
| `/goal start <objective>`                           | Create a new goal for the current session.                               |
| `/goal set <objective>`, `/goal create <objective>` | Aliases for `start`.                                                     |
| `/goal <objective>`                                 | Also creates a new goal (any text that is not a recognized action word). |
| `/goal edit <objective>`                            | Reword the current objective; status and token accounting stay put.      |
| `/goal pause [note]`                                | Pause an active goal.                                                    |
| `/goal resume [note]`                               | Resume a paused, blocked, usage-limited, or budget-limited goal.         |
| `/goal complete [note]`                             | Mark the goal achieved.                                                  |
| `/goal done [note]`                                 | Alias for `complete`.                                                    |
| `/goal block [note]`                                | Mark the goal blocked.                                                   |
| `/goal blocked [note]`                              | Alias for `block`.                                                       |
| `/goal clear`                                       | Remove the goal from the session.                                        |

Only one goal can exist on a session at a time. Starting a second goal fails
with `Goal error: goal already exists` until the current one is cleared.

`/goal start` does not take a token-budget flag; a budget can only be set
through the model-facing `create_goal` tool.

## Statuses

- `active`: the session is pursuing the goal.
- `paused`: the operator paused the goal; `/goal resume` makes it active
  again.
- `blocked`: the agent or operator reported a real blocker; `/goal resume`
  makes it active again when new information or state is available.
- `budget_limited`: the configured token budget was reached; `/goal resume`
  restarts pursuit from the same objective with a fresh budget window.
- `usage_limited`: reserved for a future usage-limit stop state; `/goal
resume` restarts pursuit the same way.
- `complete`: the goal was achieved. Complete goals are terminal; use `/goal
clear` before starting another goal.

`/new` and `/reset` clear the current session goal, since they intentionally
start fresh session context.

## Token budgets

Goals can have an optional positive token budget, set through the
`create_goal` tool's `token_budget` parameter. The budget is measured from the
session's fresh token count at goal-creation time. If the session only has a
stale or unknown token snapshot when the goal starts, OpenClaw waits for the
next fresh snapshot and uses that as the baseline, so tokens spent before the
goal existed are not charged to it.

When usage reaches the budget, the goal moves to `budget_limited`. This does
not delete the goal or erase the objective; it tells the operator and the
agent that the goal is no longer actively being pursued until it is resumed or
cleared. Resuming starts a new budget window at the current fresh token
count.

Token budgets are a session-goal guardrail, not a billing cap. Provider
quota, cost reporting, and context-window behavior still use the normal
OpenClaw usage and model controls.

## Model tools

OpenClaw exposes three goal tools to agent harnesses:

| Tool          | Purpose                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `get_goal`    | Read the current session goal: status, objective, token usage, and token budget.                                         |
| `create_goal` | Create a goal only when the user or system instructions explicitly request one. Fails if the session already has a goal. |
| `update_goal` | Mark the goal `complete` or `blocked`.                                                                                   |

The model cannot silently pause, resume, clear, or replace a goal. Those stay
operator/session controls through `/goal` and reset commands, so the agent
can report achievement or a genuine blocker without quietly moving the
target.

`update_goal` should mark a goal `complete` only when the objective is
actually achieved. It should mark a goal `blocked` only after the same
blocking condition recurs for at least three consecutive goal turns, not for
ordinary difficulty or missing polish. Updating goal status does not send a
chat reply; the agent must still provide the user's requested final response.

## Goal context on every turn

Every user/chat turn with an active goal includes this user-role context line:

```text
Active goal: <objective> — advance; keep active until fully achieved; block only after the same blocker on 3 consecutive turns; after update_goal, provide the requested visible final.
```

OpenClaw keeps the line compact by truncating long objectives. Paused,
blocked, budget-limited, usage-limited, and complete goals are not injected,
so an operator stop remains in effect until the goal is resumed.

## Control UI

Select **Goal** from the command picker, type the objective, and send. The
composer shows a Goal label so you can see what Send will do. The objective is
literal text: words such as `clear` and text such as `/stop` do not become
commands in Goal mode. Cancel leaves the objective as a normal chat draft.

Starting a Goal saves the Goal, its user turn, and the run admission together
before acknowledging Send. A failed admission leaves the draft intact and
does not create a Goal. Start and Resume require an idle local session with
recoverable history; they are not queued or steered into another run. The UI
reports unsupported or busy sessions rather than creating an inactive Goal.

The web Control UI shows the goal as a compact pill above the chat composer:
a status icon, the status label (for example `Pursuing goal`), the truncated
objective, and a live elapsed timer.

The pill carries inline controls:

- **Pencil** opens an Edit Goal composer with the current objective. Saving
  changes only the objective; cancelling restores the previous chat draft.
- **Pause / resume** updates the current Goal. Resume also starts a continuation
  through normal chat admission. Its internal input stays in model history
  without appearing as a human chat message; the assistant reply remains visible.
- **Trash** clears the current Goal.
- **Chevron** expands the pill to show the full objective, the latest status
  note, token usage, and elapsed time.

Edit, Pause, and Clear do not send slash commands or add chat turns. Controls
target the displayed Goal ID, so a stale button cannot change a replacement
Goal. If a request is interrupted, retry it unchanged; a successful replay
refreshes the current state instead of restoring an old Goal snapshot.

The action buttons are unavailable without a connection; the expand chevron
keeps working. Concurrent Goal actions are rejected while an operation is
pending. These controls require
a Gateway advertising the structured Goal capability. Text `/goal` commands
remain available for CLI and other command-capable surfaces.

### Gateway requests and retries

Goal start uses `chat.send` with the ordinary `message` as the objective and
`intent: { kind: "session-goal-start", version: 1, issuedAtMs }`. It keeps the
normal `idempotencyKey`, attachment, and reply fields. Per-request runtime or
delivery-route overrides are rejected; Goal work uses the session settings and
local delivery so recovery keeps the same contract. Objectives
must contain non-whitespace text and are limited to 16,000 characters.

`sessions.goal.update` accepts `edit` with `objective`, or `pause`, `resume`,
`block`, and `complete` with an optional `note` of at most 2,000 characters.
`sessions.goal.clear` removes the Goal. Both methods require `sessionKey`,
`goalId`, `operationId`, and `issuedAtMs`; `agentId` and `sessionId` can pin the
target. They require normal session participation and `operator.write` scope.

Keep the original operation ID, timestamp, target, and payload for retries.
Receipts remain valid for 24 hours from `issuedAtMs`; timestamps more than
five minutes ahead of the Gateway clock are rejected. Reusing an ID with a
different request is rejected. Expired requests cannot recreate a cleared
Goal. The per-session limit is 4,096 unexpired receipts; hitting it rejects
new operations until receipts expire rather than evicting valid retry state.

Results include `operationId`, `action`, `sessionId`, `goalId`, and `status`
(`started`, `updated`, or `cleared`), plus the resulting `goal` when present
and `runId` for start/resume. A replay adds `replayed: true`: this is the
original operation result, not the current Goal state. Refresh the session
after replay. Receipts prevent duplicate Goal mutations and input turns;
they do not promise exactly-once external tool or provider effects.

## TUI

The TUI footer keeps the active session's goal visible next to the agent,
session, and model fields, before token/mode indicators.

Footer examples:

- `Pursuing goal (12k/50k)` for an active goal with a token budget.
- `Goal paused (/goal resume)` for a paused goal.
- `Goal blocked (/goal resume)` for a blocked goal.
- `Goal hit usage limits (/goal resume)` for a usage-limited goal.
- `Goal unmet (50k/50k)` for a budget-limited goal.
- `Goal achieved (42k)` for a completed goal.

The footer is intentionally compact. Use `/goal` for the full objective,
note, token budget, and available commands.

## Channel behavior

`/goal` works in command-capable OpenClaw sessions, including the TUI and
chat surfaces that permit text commands. Goal state is attached to the
session key, not the transport, so two surfaces sharing a session key see the
same goal.

Goal state is not a delivery directive: it does not force replies through a
channel, change queue behavior, approve tools, or schedule work.

## Troubleshooting

| Message                                | Meaning                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Goal error: goal already exists`      | The session already has a goal. Use `/goal` to inspect it, `/goal complete` if done, or `/goal clear` before starting a different objective. |
| `Goal error: goal not found`           | The session has no goal yet. Start one with `/goal start <objective>`.                                                                       |
| `Goal error: goal is already complete` | The goal is terminal. Clear it before starting or resuming another objective.                                                                |

If token usage shows `0` or looks stale, the active session may not have a
fresh token snapshot yet. Usage refreshes as OpenClaw records session usage
and transcript-derived totals.

## Related

- [Slash commands](/tools/slash-commands)
- [TUI](/web/tui)
- [Session tool](/concepts/session-tool)
- [Compaction](/concepts/compaction)
- [Task Flow](/automation/taskflow)
- [Standing orders](/automation/standing-orders)
