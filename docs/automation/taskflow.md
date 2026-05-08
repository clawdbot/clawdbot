---
summary: "Task Flow flow orchestration layer above background tasks"
read_when:
  - You want to understand how Task Flow relates to background tasks
  - You encounter Task Flow or openclaw tasks flow in release notes or docs
  - You want to inspect or manage durable flow state
title: "Task flow"
---

Task Flow is the flow orchestration substrate that sits above [background tasks](/automation/tasks). It manages durable multi-step flows with their own state, revision tracking, and sync semantics while individual tasks remain the unit of detached work.

## When to use Task Flow

Use Task Flow when work spans multiple sequential or branching steps and you need durable progress tracking across gateway restarts. For single background operations, a plain [task](/automation/tasks) is sufficient.

| Scenario                              | Use                  |
| ------------------------------------- | -------------------- |
| Single background job                 | Plain task           |
| Multi-step pipeline (A then B then C) | Task Flow (managed)  |
| Observe externally created tasks      | Task Flow (mirrored) |
| One-shot reminder                     | Cron job             |

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

Use `session:<id>` instead of `isolated` when the recurring workflow needs deliberate history, previous run summaries, or standing context. Use `isolated` when each run should start fresh and all required state is explicit in the workflow.

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

## Sync modes

### Managed mode

Task Flow owns the lifecycle end-to-end. It creates tasks as flow steps, drives them to completion, and advances the flow state automatically.

Example: a weekly report flow that (1) gathers data, (2) generates the report, and (3) delivers it. Task Flow creates each step as a background task, waits for completion, then moves to the next step.

```
Flow: weekly-report
  Step 1: gather-data     → task created → succeeded
  Step 2: generate-report → task created → succeeded
  Step 3: deliver         → task created → running
```

### Mirrored mode

Task Flow observes externally created tasks and keeps flow state in sync without taking ownership of task creation. This is useful when tasks originate from cron jobs, CLI commands, or other sources and you want a unified view of their progress as a flow.

Example: three independent cron jobs that together form a "morning ops" routine. A mirrored flow tracks their collective progress without controlling when or how they run.

## Durable state and revision tracking

Each flow persists its own state and tracks revisions so progress survives gateway restarts. Revision tracking enables conflict detection when multiple sources attempt to advance the same flow concurrently.
The flow registry uses SQLite with bounded write-ahead-log maintenance, including
periodic and shutdown checkpoints, so long-running gateways do not retain
unbounded `registry.sqlite-wal` sidecar files.

## Cancel behavior

`openclaw tasks flow cancel` sets a sticky cancel intent on the flow. Active tasks within the flow are cancelled, and no new steps are started. The cancel intent persists across restarts, so a cancelled flow stays cancelled even if the gateway restarts before all child tasks have terminated.

## CLI commands

```bash
# List active and recent flows
openclaw tasks flow list

# Show details for a specific flow
openclaw tasks flow show <lookup>

# Cancel a running flow and its active tasks
openclaw tasks flow cancel <lookup>
```

| Command                           | Description                                   |
| --------------------------------- | --------------------------------------------- |
| `openclaw tasks flow list`        | Shows tracked flows with status and sync mode |
| `openclaw tasks flow show <id>`   | Inspect one flow by flow id or lookup key     |
| `openclaw tasks flow cancel <id>` | Cancel a running flow and its active tasks    |

## How flows relate to tasks

Flows coordinate tasks, not replace them. A single flow may drive multiple background tasks over its lifetime. Use `openclaw tasks` to inspect individual task records and `openclaw tasks flow` to inspect the orchestrating flow.

## Related

- [Background Tasks](/automation/tasks) — the detached work ledger that flows coordinate
- [CLI: tasks](/cli/tasks) — CLI command reference for `openclaw tasks flow`
- [Automation Overview](/automation) — all automation mechanisms at a glance
- [Cron Jobs](/automation/cron-jobs) — scheduled jobs that may feed into flows
