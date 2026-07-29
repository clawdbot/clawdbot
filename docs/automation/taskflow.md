---
summary: "Task Flow orchestration layer above background tasks"
read_when:
  - You want to understand how Task Flow relates to background tasks
  - You encounter Task Flow or openclaw tasks flow in release notes or docs
  - You want to inspect or manage durable flow state
title: "Task flow"
---

Task Flow is the orchestration layer above [background tasks](/automation/tasks). A flow is a durable record of multi-step work with its own status, JSON state, revision counter, and linked task records. Flows survive gateway restarts; individual tasks remain the unit of detached work.

## When to use Task Flow

| Scenario                                  | Use                                         |
| ----------------------------------------- | ------------------------------------------- |
| Single background job                     | Plain task                                  |
| Multi-step pipeline driven by plugin code | Task Flow (managed)                         |
| Detached ACP or subagent spawn            | Task Flow (mirrored, created automatically) |
| One-shot reminder                         | Cron job                                    |

## Sync modes

### Managed mode

A managed flow has a controller: plugin code that creates the flow through the plugin runtime Task Flow API with a goal and a required controller id, then drives it explicitly.

- Each step runs as a background task created under the flow; the flow's owner key and requester origin carry over to child tasks.
- The controller advances the flow between `running`, `waiting`, and terminal states, and stores arbitrary JSON step state on the flow record.
- Every mutation passes the flow's expected revision. A stale write is rejected as a revision conflict instead of clobbering newer state.
- Once cancellation is requested, new child tasks are refused, and the flow finalizes as `cancelled` when no child task remains active.

Example: a weekly report flow that (1) gathers data, (2) generates the report, and (3) delivers it, one background task per step:

```
Flow: weekly-report
  Step 1: gather-data     → task created → succeeded
  Step 2: generate-report → task created → succeeded
  Step 3: deliver         → task created → running
```

### Mirrored mode

OpenClaw creates a mirrored one-task flow automatically when a detached ACP or subagent run starts (session-scoped tasks with deliverable completion). The flow record mirrors its single backing task - status, goal, and timing - so detached spawns get a stable flow handle for status and retry surfaces without a controller. Mirrored flows show sync mode `task_mirrored` in the CLI.

## Flow statuses

| Status      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `queued`    | Created, not yet progressing                                               |
| `running`   | Flow is actively progressing                                               |
| `waiting`   | Managed flow is parked on wait metadata (timer, external event)            |
| `blocked`   | A step finished without a usable result; `blockedTaskId`/summary say which |
| `succeeded` | Completed successfully                                                     |
| `failed`    | Completed with an error                                                    |
| `cancelled` | Cancel requested and all child tasks settled                               |
| `lost`      | Flow lost its authoritative backing state                                  |

## Durable state and revision tracking

Flow records persist in the shared SQLite state database (`~/.openclaw/state/openclaw.sqlite`, `flow_runs` table) alongside task records, so progress survives gateway restarts. Each write bumps the flow's `revision`; concurrent writers that pass a stale expected revision get a conflict and must re-read. WAL growth is bounded by SQLite autocheckpointing plus periodic passive checkpoints, with truncate checkpoints on shutdown. The legacy `flows/registry.sqlite` sidecar from older installs is imported by `openclaw doctor`.

## Cancel behavior

`openclaw tasks flow cancel` sets a sticky cancel intent on the flow, cancels its active child tasks, and refuses new managed child tasks. Once no child task remains active, the flow finalizes as `cancelled` - immediately, or via the maintenance sweep if children take longer to settle. The intent is persisted, so a cancelled flow stays cancelled even if the gateway restarts before all child tasks have terminated.

## CLI commands

```bash
# List active and recent flows
openclaw tasks flow list [--status <status>] [--json]

# Show details for a specific flow
openclaw tasks flow show <lookup> [--json]

# Cancel a running flow and its active tasks
openclaw tasks flow cancel <lookup>
```

| Command                           | Description                                                             |
| --------------------------------- | ----------------------------------------------------------------------- |
| `openclaw tasks flow list`        | Tracked flows with sync mode, status, revision, controller, task counts |
| `openclaw tasks flow show <id>`   | Inspect one flow by flow id or owner key, including linked tasks        |
| `openclaw tasks flow cancel <id>` | Cancel a running flow and its active tasks                              |

Flows are also covered by `openclaw tasks audit` (stale or broken flow findings) and `openclaw tasks maintenance` (finalizes stuck cancels, prunes terminal flows after 7 days).

## Reliable scheduled workflow pattern

For recurring workflows such as market intelligence briefings, treat the schedule, orchestration, and reliability checks as separate layers:

1. Use [Scheduled Tasks](/automation/cron-jobs) for timing.
2. Use a persistent cron session when the workflow should build on prior context.
3. Use [Lobster](/tools/lobster) for deterministic steps, approval gates, and resume tokens.
4. Use Task Flow to track the multi-step run across child tasks, waits, retries, and gateway restarts.

Example cron shape:

```bash
openclaw cron add \
  --name "Market intelligence brief" \
  --cron "0 7 * * 1-5" \
  --tz "America/New_York" \
  --session session:market-intel \
  --message "Run the market-intel Lobster workflow. Verify source freshness before summarizing." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

Use `--session session:<id>` instead of `isolated` when the recurring workflow needs deliberate history, previous run summaries, or standing context. Use `isolated` when each run should start fresh and all required state is explicit in the workflow.

Inside the workflow, put reliability checks before the LLM summary step:

```yaml
name: market-intel-brief
steps:
  - id: preflight
    command: market-intel check --json
  - id: collect
    command: market-intel collect --json
    stdin: $preflight.json
  - id: summarize
    command: market-intel summarize --json
    stdin: $collect.json
  - id: approve
    command: market-intel deliver --preview
    stdin: $summarize.json
    approval: required
  - id: deliver
    command: market-intel deliver --execute
    stdin: $summarize.json
    condition: $approve.approved
```

Recommended preflight checks:

- Browser availability and profile choice, for example `openclaw` for managed state or `user` when a signed-in Chrome session is required. See [Browser](/tools/browser).
- API credentials and quota for each source.
- Network reachability for required endpoints.
- Required tools enabled for the agent, such as `lobster`, `browser`, and `llm-task`.
- Failure destination configured for cron so preflight failures are visible. See [Scheduled Tasks](/automation/cron-jobs#delivery-and-output).

Recommended data provenance fields for every collected item:

```json
{
  "sourceUrl": "https://example.com/report",
  "retrievedAt": "2026-04-24T12:00:00Z",
  "asOf": "2026-04-24",
  "title": "Example report",
  "content": "..."
}
```

Have the workflow reject or mark stale items before summarization. The LLM step should receive only structured JSON and should be asked to preserve `sourceUrl`, `retrievedAt`, and `asOf` in its output. Use [LLM Task](/tools/llm-task) when you need a schema-validated model step inside the workflow.

For reusable team or community workflows, package the CLI, `.lobster` files, and any setup notes as a skill or plugin and publish it through [ClawHub](/clawhub). Keep workflow-specific guardrails in that package unless the plugin API is missing a needed generic capability.

## How flows relate to tasks

Flows coordinate tasks, not replace them. A single flow may drive multiple background tasks over its lifetime. Use `openclaw tasks` to inspect individual task records and `openclaw tasks flow` to inspect the orchestrating flow.

## Related

- [Background Tasks](/automation/tasks) - the detached work ledger that flows coordinate
- [CLI: tasks](/cli/tasks) - CLI command reference for `openclaw tasks flow`
- [Automation Overview](/automation) - all automation mechanisms at a glance
- [Cron Jobs](/automation/cron-jobs) - scheduled jobs that may feed into flows
