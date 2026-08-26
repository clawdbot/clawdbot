---
summary: "Background task tracking for ACP runs, subagents, automation runs, and CLI operations"
read_when:
  - Inspecting background work in progress or recently completed
  - Debugging delivery failures for detached agent runs
  - Understanding how background runs relate to sessions, automations, and heartbeat
title: "Background tasks"
sidebarTitle: "Background tasks"
---

<Note>
Looking for scheduling? See [Automation](/automation) for choosing the right mechanism. This page is the activity ledger for background work, not the scheduler.
</Note>

Background tasks track work that runs **outside your main conversation session**: ACP runs, subagent spawns, automation job runs, and CLI-initiated operations.

Tasks do **not** replace sessions, automations, or heartbeats - they are the **activity ledger** that records what detached work happened, when, and whether it succeeded.

For a strict, ephemeral one-shot agent run in CI or a script, use [`openclaw agent exec`](/cli/agent#agent-exec) instead of managed background work.

<Note>
Not every agent run creates a task. Heartbeat turns and normal interactive chat do not. All automation runs, ACP spawns, subagent spawns, gateway-dispatched CLI agent commands, and agent-started background `exec` commands do.
</Note>

## TL;DR

- Tasks are **records**, not schedulers - automations and heartbeat decide _when_ work runs, tasks track _what happened_.
- ACP, subagents, all automation jobs, and CLI operations create tasks. Heartbeat turns do not.
- Each task moves through `queued → running → terminal` (succeeded, failed, timed_out, cancelled, or lost).
- Automation tasks stay live while the automations runtime still owns the job; if the in-memory runtime state is gone, task maintenance first checks durable automation run history before marking a task lost.
- Completion is push-driven: detached work can notify directly or wake the requester session/heartbeat when it finishes, so status polling loops are usually the wrong shape.
- Isolated automation runs and subagent completions best-effort clean up tracked browser tabs/processes for their child session before final cleanup bookkeeping.
- Isolated automation delivery suppresses stale interim parent replies while descendant subagent work is still draining, and it prefers final descendant output when that arrives before delivery.
- Completion notifications are delivered directly to a channel or queued for the next heartbeat.
- `openclaw tasks list` shows all tasks; `openclaw tasks audit` surfaces issues.
- Terminal records are kept for 7 days (`lost` records for 24 hours), then automatically pruned.

## Quick start

<Tabs>
  <Tab title="List and filter">
    ```bash
    # List all tasks (newest first)
    openclaw tasks list

    # Filter by runtime or status
    openclaw tasks list --runtime acp
    openclaw tasks list --status running
    openclaw tasks list --status blocked
    ```

  </Tab>
  <Tab title="Inspect">
    ```bash
    # Show details for a specific task (by task ID, run ID, or session key)
    openclaw tasks show <lookup>
    ```
  </Tab>
  <Tab title="Cancel and notify">
    ```bash
    # Cancel a running task (kills the child session)
    openclaw tasks cancel <lookup>

    # Change notification policy for a task
    openclaw tasks notify <lookup> state_changes
    ```

  </Tab>
  <Tab title="Recover delivery">
    ```bash
    # Retry or dismiss up to 10 blocked completion deliveries
    openclaw tasks retry <lookup> [lookup...]
    openclaw tasks dismiss <lookup> [lookup...]
    ```

  </Tab>
  <Tab title="Audit and maintenance">
    ```bash
    # Run a health audit
    openclaw tasks audit

    # Preview or apply maintenance
    openclaw tasks maintenance
    openclaw tasks maintenance --apply
    ```

  </Tab>
  <Tab title="Task flow">
    ```bash
    # Inspect TaskFlow state
    openclaw tasks flow list
    openclaw tasks flow show <lookup>
    openclaw tasks flow cancel <lookup>
    ```
  </Tab>
</Tabs>

## What creates a task

| Source                      | Runtime type | When a task record is created                                          | Default notify policy |
| --------------------------- | ------------ | ---------------------------------------------------------------------- | --------------------- |
| ACP background runs         | `acp`        | Spawning a child ACP session                                           | `done_only`           |
| Subagent orchestration      | `subagent`   | Spawning a subagent via `sessions_spawn`                               | `done_only`           |
| Automation jobs (all types) | `cron`       | Every automation run (main-session and isolated)                       | `silent`              |
| CLI operations              | `cli`        | `openclaw agent` commands that run through the gateway                 | `silent`              |
| Agent media jobs            | `cli`        | Session-backed `image_generate`/`music_generate`/`video_generate` runs | `silent`              |

<AccordionGroup>
  <Accordion title="Notify defaults for automations and media">
    Automation tasks (main-session and isolated) use `silent` notify policy - they create records for tracking but do not generate task notifications of their own; the scheduler owns its delivery path.

    Session-backed `image_generate`, `music_generate`, and `video_generate` runs also use `silent` notify policy. They still create task records, but completion is handed back to the original agent session as an internal wake. The requester agent follows its current visible-reply contract: successful completion includes a short user-facing caption and every structured generated attachment from the completion event, while failure produces a concise visible failure. Internal task and session details stay private. If the requester session is no longer active or its active wake fails, and the completion agent misses some or all generated media, OpenClaw sends an idempotent direct fallback with only the missing media to the original channel target.

  </Accordion>
  <Accordion title="Concurrent media-generation guardrail">
    While a session-backed media-generation task is still active, `image_generate`, `music_generate`, and `video_generate` guard against accidental retries: repeating the call for the same prompt/request returns the matching active task status instead of starting a duplicate, while a distinct prompt can start its own task. Use `action: "status"` when you want an explicit progress/status lookup from the agent side.
  </Accordion>
  <Accordion title="What does not create tasks">
    - Heartbeat turns - main-session; see [Heartbeat](/gateway/heartbeat)
    - Normal interactive chat turns
    - Direct `/command` responses

  </Accordion>
</AccordionGroup>

## Task lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running : agent starts
    running --> succeeded : completes ok
    running --> failed : error
    running --> timed_out : timeout exceeded
    queued --> cancelled : operator cancels
    running --> cancelled : operator cancels
    queued --> lost : backing state gone > 5 min
    running --> lost : backing state gone > 5 min
```

| Status      | What it means                                                               |
| ----------- | --------------------------------------------------------------------------- |
| `queued`    | Created, waiting for the agent to start                                     |
| `running`   | Agent turn is actively executing                                            |
| `succeeded` | Completed successfully                                                      |
| `failed`    | Completed with an error                                                     |
| `timed_out` | Exceeded the configured timeout                                             |
| `cancelled` | Stopped by the operator via `openclaw tasks cancel`, or the run was aborted |
| `lost`      | The runtime lost authoritative backing state after a 5-minute grace period  |

Transitions happen automatically - agent run lifecycle events (start, end, error) update the task status; you do not manage it manually.

Execution and result delivery are separate. A subagent task can remain
`succeeded` while its `deliveryStatus` is `session_queued` or `failed`. The
terminal outcome is `succeeded` after delivery and `blocked` when the work
finished but the result could not be handed back. This preserves the completed
result instead of misreporting the child execution as failed.

Use `openclaw tasks list --status blocked` to find these tasks. They also remain
in `--status succeeded` results because the underlying execution succeeded, and
JSON output preserves the stored status plus the `blocked` terminal outcome.

Agent run completion is authoritative for active task records. A successful detached run finalizes as `succeeded`, ordinary run errors finalize as `failed`, timeouts finalize as `timed_out`, and cancel/abort outcomes finalize as `cancelled`. Once a task is terminal, later lifecycle signals do not downgrade it - an operator-cancelled or already-`failed`/`timed_out`/`lost` task stays that way even if a success signal arrives afterwards.

`lost` is runtime-aware:

- ACP tasks: only a live in-process ACP turn in the Gateway proves the run is alive; persisted session metadata alone does not. Offline CLI audit stays conservative and never reclaims ACP tasks.
- Subagent tasks: backing child session disappeared from the target agent store (or carries a restart-recovery tombstone).
- Automation tasks: the automations runtime no longer tracks the job as active and durable run history does not show a terminal result for that run. Offline CLI audit does not treat its own empty in-process automations runtime state as authority.
- CLI tasks: tasks with a run id/source id use the live run context, so lingering child-session or chat-session rows do not keep them alive after the gateway-owned run disappears. Legacy CLI tasks without run identity still fall back to the child session. Gateway-backed `openclaw agent` runs also finalize from their run result, so completed runs do not sit active until the sweeper marks them `lost`.

## Delivery and notifications

When a task reaches a terminal state, OpenClaw notifies you. There are two delivery paths:

**Direct delivery** - if the task has a channel target (the `requesterOrigin`), the completion message goes straight to that channel (Discord, Slack, Telegram, etc.). Group and channel task completions are instead routed through the requester session so the parent agent can write the visible reply. For subagent completions, OpenClaw also preserves bound thread/topic routing when available and can fill a missing `to` / account from the requester session's stored route (`lastChannel` / `lastTo` / `lastAccountId`) before giving up on direct delivery.

**Session-queued delivery** - if direct delivery fails or no origin is set, the update is queued as a system event in the requester's session and surfaces on the next heartbeat.

Durable subagent completion handoffs retry for up to 30 minutes with capped
exponential backoff. A queued handoff is not reported as delivered until the
queue settles. If delivery reaches its deadline or fails permanently, the task
shows a blocked terminal outcome and retains its canonical result for 7 days.
Use `openclaw tasks retry` to create a fenced new delivery generation, or
`openclaw tasks dismiss` to record intentional non-delivery. Retry can duplicate
a visible result when an earlier provider acknowledgement was ambiguous.

<Tip>
Session-queued task completions trigger an immediate heartbeat wake, so you see the result quickly - you do not have to wait for the next scheduled heartbeat tick.
</Tip>

That means the usual workflow is push-based: start detached work once, then let the runtime wake or notify you on completion. Poll task state only when you need debugging, intervention, or an explicit audit.

### Notification policies

Control how much you hear about each task:

| Policy                | What is delivered                                             |
| --------------------- | ------------------------------------------------------------- |
| `done_only` (default) | Only terminal state (succeeded, failed, etc.)                 |
| `state_changes`       | Every state transition and progress update                    |
| `silent`              | Nothing at all (default for automation, CLI, and media tasks) |

Change the policy while a task is running:

```bash
openclaw tasks notify <lookup> state_changes
```

## CLI reference

<AccordionGroup>
  <Accordion title="tasks list">
    ```bash
    openclaw tasks list [--runtime <acp|subagent|cron|cli>] [--status <status>] [--json]
    ```

    Output columns: Task, Kind, Status, Delivery, Run, Child Session, Summary. Bare `openclaw tasks` behaves like `openclaw tasks list`.

  </Accordion>
  <Accordion title="tasks show">
    ```bash
    openclaw tasks show <lookup> [--json]
    ```

    The lookup token accepts a task ID, run ID, or session key. Shows the full record including timing, delivery state, error, and terminal summary.

  </Accordion>
  <Accordion title="tasks cancel">
    ```bash
    openclaw tasks cancel <lookup>
    ```

    For ACP and subagent tasks, this kills the child session; ACP and automation cancellations route through the running Gateway (`tasks.cancel`). For CLI-tracked tasks, cancellation is recorded in the task registry (there is no separate child runtime handle). Status transitions to `cancelled` and a delivery notification is sent when applicable.

  </Accordion>
  <Accordion title="tasks retry | dismiss">
    ```bash
    openclaw tasks retry <lookup> [lookup...]
    openclaw tasks dismiss <lookup> [lookup...]
    ```

    These commands recover blocked subagent completion deliveries. Each request
    accepts 1-10 task lookups. Retry preserves the canonical result and starts a
    new fenced queue generation; dismiss keeps the task blocked and records that
    the operator intentionally stopped delivery.

  </Accordion>
  <Accordion title="tasks notify">
    ```bash
    openclaw tasks notify <lookup> <done_only|state_changes|silent>
    ```
  </Accordion>
  <Accordion title="tasks audit">
    ```bash
    openclaw tasks audit [--severity <warn|error>] [--code <name>] [--limit <n>] [--json]
    ```

    Surfaces operational issues for tasks **and** TaskFlows in one report. Findings also appear in `openclaw status` when issues are detected.

    Task findings:

    | Finding                   | Severity   | Trigger                                                                                                      |
    | ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
    | `stale_queued`            | warn       | Queued for more than 10 minutes                                                                              |
    | `stale_running`           | error      | Running for more than 30 minutes                                                                             |
    | `lost`                    | warn/error | Runtime-backed task ownership disappeared; retained lost tasks warn until `cleanupAfter`, then become errors |
    | `delivery_failed`         | warn       | Delivery failed and notify policy is not `silent`                                                            |
    | `missing_cleanup`         | warn       | Terminal task with no cleanup timestamp                                                                      |
    | `inconsistent_timestamps` | warn       | Timeline violation (for example ended before started)                                                        |

    TaskFlow findings:

    | Finding                | Severity   | Trigger                                                                    |
    | ---------------------- | ---------- | --------------------------------------------------------------------------- |
    | `restore_failed`       | error      | Flow registry restore from SQLite failed                                    |
    | `stale_running`        | error      | Running flow has not advanced for more than 30 minutes                      |
    | `stale_waiting`        | warn       | Waiting flow has not advanced for more than 30 minutes                      |
    | `stale_blocked`        | warn       | Blocked flow has not advanced for more than 30 minutes                      |
    | `cancel_stuck`         | warn       | Cancel requested over 5 minutes ago, no active child tasks, still nonterminal |
    | `missing_linked_tasks` | warn/error | Stale managed flow with no linked tasks or wait state                       |
    | `blocked_task_missing` | warn       | Blocked flow points at a task id that no longer exists                      |

  </Accordion>
  <Accordion title="tasks maintenance">
    ```bash
    openclaw tasks maintenance [--json]
    openclaw tasks maintenance --apply [--json]
    ```

    Use this to preview or apply reconciliation, cleanup stamping, and pruning for tasks, TaskFlow state, and stale automation run session registry rows.

    Reconciliation is runtime-aware:

    - ACP tasks require a live in-process turn in the Gateway; subagent tasks check their backing child session.
    - Subagent tasks whose child session has a restart-recovery tombstone are marked lost instead of being treated as recoverable backing sessions.
    - Automation tasks check whether the automations runtime still owns the job, then recover terminal status from persisted run logs/job state before falling back to `lost`. Only the Gateway process is authoritative for the in-memory active-job set; offline CLI audit uses durable history but does not mark an automation task lost solely because that local set is empty.
    - CLI tasks with run identity check the owning live run context, not just child-session or chat-session rows.

    Completion cleanup is also runtime-aware:

    - Subagent completion best-effort closes tracked browser tabs/processes for the child session before announce cleanup continues.
    - Isolated automation completion best-effort closes tracked browser tabs/processes for the run's session before the run fully tears down.
    - Isolated automation delivery waits out descendant subagent follow-up when needed and suppresses stale parent acknowledgement text instead of announcing it.
    - Subagent completion delivery uses the child's latest visible assistant text only. Tool/toolResult output is not promoted into child result text. Terminal failed runs announce failure status without replaying captured reply text.
    - Cleanup failures do not mask the real task outcome.

    When applying maintenance, OpenClaw also removes stale `cron:<jobId>:run:<runId>` session registry rows older than 7 days, while preserving rows for currently running automation jobs and leaving other session rows untouched.

  </Accordion>
  <Accordion title="tasks flow list | show | cancel">
    ```bash
    openclaw tasks flow list [--status <status>] [--json]
    openclaw tasks flow show <lookup> [--json]
    openclaw tasks flow cancel <lookup>
    ```

    The flow lookup token accepts a flow id or owner key. Use these when the orchestrating [Task Flow](/automation/taskflow) is the thing you care about rather than one individual background task record.

  </Accordion>
</AccordionGroup>

## Chat task board (`/tasks`)

Use `/tasks` in any chat session to see background tasks linked to that session. The board shows up to five active and recently completed tasks with runtime, status, timing, and progress or error detail.

When the current session has no visible linked tasks, `/tasks` falls back to agent-local task counts so you still get an overview without leaking other-session details.

For the full operator ledger, use the CLI: `openclaw tasks list`.

### Control UI

The web Control UI has a **Tasks** page in the sidebar with live active and recent background tasks. Use it to inspect progress, open linked sessions, refresh the ledger, cancel queued and running tasks, or retry/dismiss a blocked completion delivery. Task detail keeps execution status and delivery status separate and exposes the retained result for copying.

Chat panes also have a collapsible **Background tasks** rail scoped to the pane's agent, with running work, stop controls, and a finished section. Open it from the activity toggle in the pane header (or the floating activity button in single-pane chat).

Select a task to replace the list with a compact detail view inside the rail; use the back button to return to the list. The detail view shows the bounded input prompt, latest output or error summary, timing, and current tool activity. Subagent details stay in the rail rather than opening their child conversation in the main chat pane; linked-session actions remain available for task runtimes intended for direct inspection. On iOS, open **Chat actions → Background Tasks**; on Android, open the Chat overflow menu and select **Background tasks**. Both mobile views use the same Running and Finished grouping and open task details on selection.

## Status integration (task pressure)

`openclaw status` includes an at-a-glance task line:

```
Tasks    2 active · 1 queued · 1 running · 1 issue · audit clean · 6 tracked
```

The summary counts active work (`queued` + `running`), failures (`failed` + `timed_out` + `lost`), audit findings, and total tracked records; the JSON payload also breaks counts down by runtime (`acp`, `subagent`, `cron`, `cli`).

Both `/status` and the `session_status` tool use a cleanup-aware task snapshot: active tasks are preferred, expired rows are hidden, and terminal tasks only appear for a short recent window (5 minutes), with failures focused when no active work remains. This keeps the status card on what matters right now.

## Storage and maintenance

### Where tasks live

Task records and delivery state persist in the shared OpenClaw SQLite state database:

```
~/.openclaw/state/openclaw.sqlite   (tables: task_runs, task_delivery_state, flow_runs)
```

Set `OPENCLAW_STATE_DIR` to move the whole state root (default `~/.openclaw`) elsewhere; the shared database path moves with it.

The registry loads into memory on first use and persists every write back to SQLite, so records survive gateway restarts. WAL growth stays bounded through SQLite's default autocheckpoint threshold plus periodic `PASSIVE` checkpoints. After a checkpoint completes, the next commit resets the WAL and applies a 64 MiB `journal_size_limit` ceiling, so a reader cannot leave the file parked at a pathological high-water mark until restart. Shutdown and explicit maintenance checkpoints use `TRUNCATE` so normal closes reclaim WAL space without making the background sweeper wait on active readers.

Legacy sidecar stores from older installs (`tasks/runs.sqlite`, `flows/registry.sqlite`) are imported into the shared database by `openclaw doctor`.

### Automatic maintenance

A sweeper runs every **60 seconds** (first pass about 5 seconds after gateway start) and handles four things:

<Steps>
  <Step title="Reconciliation">
    Checks whether active tasks still have authoritative runtime backing. ACP tasks require a live in-process turn, subagent tasks use child-session state, automation tasks use active-job ownership plus durable run history, and CLI tasks with run identity use the owning run context. If backing state is gone for more than 5 minutes (30 minutes for childless native subagent tasks), the task is marked `lost`.
  </Step>
  <Step title="ACP session repair">
    Closes terminal or orphaned parent-owned one-shot ACP sessions, and closes stale terminal or orphaned persistent ACP sessions only when no active conversation binding remains.
  </Step>
  <Step title="Cleanup stamping">
    Sets a `cleanupAfter` timestamp on terminal tasks (terminal time + retention window). During retention, lost tasks still appear in audit as warnings; after `cleanupAfter` expires or when cleanup metadata is missing, they become errors.
  </Step>
  <Step title="Pruning">
    Deletes records past their `cleanupAfter` date.
  </Step>
</Steps>

<Note>
**Retention:** terminal task records are kept for **7 days** (`lost` records for **24 hours**), then automatically pruned. No configuration needed.
</Note>

## How tasks relate to other systems

<AccordionGroup>
  <Accordion title="Tasks and Task Flow">
    [Task Flow](/automation/taskflow) is the flow orchestration layer above background tasks. A single flow may coordinate multiple tasks over its lifetime using managed or mirrored sync modes. Use `openclaw tasks` to inspect individual task records and `openclaw tasks flow` to inspect the orchestrating flow.

  </Accordion>
  <Accordion title="Tasks and automations">
    Automation job definitions, runtime execution state, and run history live in OpenClaw's shared SQLite state database. **Every** automation run creates a task record - both main-session and isolated - with `silent` notify policy, so automation runs are tracked without generating task notifications of their own.

    See [Automations](/automation/cron-jobs).

  </Accordion>
  <Accordion title="Tasks and heartbeat">
    Heartbeat runs are main-session turns - they do not create task records. When a task completes, it can trigger a heartbeat wake so you see the result promptly.

    See [Heartbeat](/gateway/heartbeat).

  </Accordion>
  <Accordion title="Tasks and sessions">
    A task may reference a `childSessionKey` (where work runs) and a `requesterSessionKey` (who started it). Its `agentId` identifies the agent executing the work, while the requester and owner fields preserve launch and control context. Sessions are conversation context; tasks are activity tracking on top of that.
  </Accordion>
  <Accordion title="Tasks and agent runs">
A task's `runId` links to the agent run doing the work. Agent lifecycle events (start, end, error) automatically update the task status - you do not need to manage the lifecycle manually.

When execution identity collection is enabled, OpenClaw also binds the exact
admitted `contextId` and `executionId` to Gateway CLI, ACP, and automation task
rows and their mirrored flow rows. This is inspection provenance only: `runId`
remains correlation, task/flow status remains authoritative, and a missing or
mismatched binding never changes execution or settlement. `openclaw audit
--execution <id> --explain` adapts the existing rows without copying task or
flow content into the generic decision-fact table.
</Accordion>
</AccordionGroup>

## Related

- [Automation](/automation) - all automation mechanisms at a glance
- [CLI: Tasks](/cli/tasks) - CLI command reference
- [Heartbeat](/gateway/heartbeat) - periodic main-session turns
- [Automations](/automation/cron-jobs) - scheduling background work
- [Task Flow](/automation/taskflow) - flow orchestration above tasks
