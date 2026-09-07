---
doc-schema-version: 1
summary: "Schedule kinds, cron expressions, stream sources, pacing, and condition triggers"
read_when:
  - Choosing between at, every, cron, on-exit, and stream schedules
  - Writing a cron expression or a timezone-aware schedule
  - Adding a condition script that gates when a job fires
title: "Automation schedules"
sidebarTitle: "Schedules"
---

When a job fires: the five schedule kinds, cron expression rules, dynamic cadence, and condition watchers. Part of the [Automations](/automation/cron-jobs) guide.

## Schedule types

| Kind      | CLI flag           | Description                                                                                              |
| --------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `at`      | `--at`             | One-shot timestamp (ISO 8601 or relative like `20m`)                                                     |
| `every`   | `--every`          | Fixed interval (`10m`, `1h`, `1d`)                                                                       |
| `cron`    | `--cron`           | 5-field or 6-field cron expression with optional `--tz`                                                  |
| `on-exit` | `--on-exit`        | Fire once when a watched command exits (event trigger; survives turn teardown; optional `--on-exit-cwd`) |
| `stream`  | `--stream-command` | Fire from batched lines produced by a supervised long-lived command                                      |

These schedule flags work with both `openclaw automations add` and `openclaw automations edit <job-id>`. For example, `openclaw automations edit <job-id> --on-exit "./watch.sh" --on-exit-cwd /srv/app` converts an existing job to an exit-triggered schedule.

Timestamps without a timezone are treated as UTC. Add `--tz America/New_York` to interpret an offset-less `--at` datetime, or to evaluate a cron expression, in that IANA timezone. Cron expressions without `--tz` use the Gateway host timezone. `--tz` is not valid with `--every` or `--on-exit`.

Recurring top-of-hour expressions (minute `0` with a wildcard hour field) are automatically staggered by up to 5 minutes to reduce load spikes. Use `--exact` to force precise timing, or `--stagger 30s` for an explicit window (cron schedules only).

### Heartbeat task migration

Older heartbeat scratch supported a structured `tasks:` block. Run `openclaw doctor --fix` after upgrading to convert each entry into an ordinary editable main-session automation job. Doctor preserves the interval and previous last-run timing, creates the jobs before removing the block, and safely converges the same declaration keys on rerun.

These migrated jobs carry public `systemEvent` payloads, so `openclaw automations list`, `get`, `edit`, and `remove` plus the `automations` agent tool manage them like other jobs (the tool still accepts its legacy `cron` name as a compatibility alias). Their execution uses the guarded heartbeat task wake: active hours, minimum spacing, flood control, and busy retries still apply, while the scheduler owns each task's independent cadence. Jobs due in the same coalescing window can share one heartbeat turn. A scheduled occurrence outside heartbeat active hours is skipped and retried at the job's next occurrence.

Heartbeat scratch is now monitor prose only. Runtime heartbeats do not parse `tasks:` text as schedules; create new recurring work as automations.

### Stream sources

A stream schedule keeps an operator-authored argv command running under the Gateway and fires the job from its stdout and stderr lines. Stream schedules are event-driven, never time-due, and are available by default. Set `cron.triggers.enabled: false` to disable them together with condition-trigger scripts and script payloads. Disabling or removing the job stops the process; Gateway shutdown waits for process-tree teardown. Fast failures restart with the scheduler's built-in error backoff. Five consecutive runs shorter than 60 seconds leave the job in an error state and use the normal failure-alert path; manually re-enable the job to clear the restart cap.

```bash
openclaw automations add \
  --name "Build event stream" \
  --stream-command '["node","scripts/build-events.mjs"]' \
  --stream-mode match \
  --stream-match '^(failed|recovered):' \
  --stream-batch-ms 250 \
  --session isolated \
  --message "Investigate these build events."
```

`mode: "line"` (the default) accepts every line. `mode: "match"` accepts only lines matching the compiled `match` regex. A batch closes after `batchMs` of quiet (default 250 ms, clamped to 50–5000) or at `maxBatchBytes` (default 16384, clamped to 1024–65536). At the byte cap the batch ends with `[truncated]`. Match mode always evaluates complete lines against their full text, even past `maxBatchBytes` (only the delivered batch is truncated); a line cut at the bounded raw-intake limit is only a prefix, so it is treated as unmatched rather than letting an end-anchored pattern fire on the cut. The batch is appended to the system-event text or agent-turn message. Command payloads are rejected for stream schedules because the source command and payload command would have ambiguous process ownership.

Only one payload fire and one bounded pending batch are retained per job. Lines arriving while a payload runs, or before the built-in 30-second trigger interval has elapsed, coalesce into that pending batch rather than building an unbounded queue. One serialized owner records gate drops, payload errors, and not-running dispatches in `streamDroppedBatches`; bounded merges increment `streamCoalescedBatches`. Failed payloads are not retried because they may not be idempotent. A logical source identity remains stable across supervised child restarts, but rotates when the source is disabled, removed, or replaced, so queued batches from the retired source cannot fire even after an A-to-B-to-A edit. After a stop completes, late callbacks from an old child are inert. V1 does not include a native WebSocket source; bridge one with an argv command such as `websocat wss://example.invalid/events`.

When a stream job also has `trigger.script`, the gate runs once per closed batch. The current batch is available as the deeply frozen `trigger.streamBatch` string alongside `trigger.state`. `fire: false` drops that batch after persisting gate state. `fire: true` keeps existing trigger message semantics, then appends the batch to the resulting payload. A stream job may instead use a script payload without a condition gate; that script receives the batch through the same `trigger.streamBatch` value. Combining a script payload with a condition gate is rejected because both would own the persisted `trigger.state` slot.

### Dynamic cadence (pacing)

Recurring jobs can set `pacing.min` and/or `pacing.max` to duration strings such as `15m` or `4h`; at least one bound is required. Use `--pacing-min` and `--pacing-max` with `automations add|edit` (`--clear-pacing` removes both bounds).

During an agent-turn run, a paced job can call the `automations` tool with `action: "next_check"` and `in: "30m"`. The proposal applies only to that currently running job and is measured from successful run completion. OpenClaw silently clamps it to the configured bounds. A future paced deadline remains the next scheduled check after a Gateway restart.

Pacing without a proposal leaves the normal schedule unchanged. Failed, timed-out, and skipped runs discard the proposal, so existing retry and error-backoff behavior takes precedence. Manually forcing a recurring job is out-of-band and preserves its pending natural or paced slot. For condition-triggered jobs, the built-in minimum interval remains a lower bound even when a proposal requests an earlier check.

### `/loop` chat shortcut

In chat, the owner-only `/loop [interval] <prompt>` command creates a recurring agent-turn job bound to that conversation. Give an interval such as `5m` for fixed cadence, or omit it to let the loop self-pace between 1 minute and 1 hour with `next_check`. Use `/loop status` to list conversation-bound loops and `/loop stop [name]` to remove them.

### Day-of-month and day-of-week use OR logic

Cron expressions are parsed by [croner](https://github.com/Hexagon/croner). When both the day-of-month and day-of-week fields are non-wildcard, croner matches when **either** field matches, not both. This is standard Vixie cron behavior.

```bash
# Intended: "9 AM on the 15th, only if it's a Monday"
# Actual:   "9 AM on every 15th, AND 9 AM on every Monday"
0 9 15 * 1
```

This fires roughly 5-6 times a month instead of 0-1 times a month. To require both conditions, use croner's `+` day-of-week modifier (`0 9 15 * +1`), or schedule on one field and guard the other in your job's prompt or command.

## Event triggers (condition watchers)

An event trigger adds a headless condition script to an `every`, `cron`, or `stream` schedule. Time schedules evaluate it when due; stream schedules evaluate it for each closed batch. The scheduler runs the normal payload only when the script returns `fire: true`:

```json5
{
  schedule: { kind: "every", everyMs: 30000 },
  trigger: {
    // Fires only when the observed status differs from the last evaluation.
    script: "const res = await exec({ command: 'gh pr checks 123 --json state -q \\'.[].state\\' | sort -u' }); const status = String(res?.aggregated ?? '').trim(); json({ fire: status !== trigger.state?.status, message: `PR 123 CI: ${trigger.state?.status ?? 'unknown'} -> ${status}`, state: { status } });",
    once: false,
  },
  payload: { kind: "agentTurn", message: "Investigate the CI status change." },
}
```

When upgrading, run `openclaw doctor --fix` to migrate persisted trigger scripts that call `tools.call('exec', args)` and read the legacy `.result.details` envelope. Doctor leaves custom or ambiguous legacy scripts unchanged and identifies each affected job for manual conversion; standalone script payloads are not migrated.

The script must return `{ fire, message?, state? }`. The previous JSON state is available as the deeply frozen `trigger.state`; stream gates also receive the current batch as `trigger.streamBatch`. Return a new `state` value to persist it. State is capped at 16 KB. When a firing result includes `message`, the scheduler appends it to the system-event text or agent-turn message before execution. `once: true` disables the job after its first successful fired payload.

`fire: false` persists evaluation state and counters, then reschedules without creating run history. If a fired payload run fails, the returned `state` is **not** persisted — the next evaluation sees the previous state and can fire again, so write scripts as read-only checks and keep actions in the payload. Trigger schedules have a built-in minimum interval of 30 seconds. Each evaluation has a 30-second wall-clock budget and up to 5 tool calls.

Removing or disabling a job during condition evaluation cancels that evaluation before its payload can start. After a main-session payload hands work to heartbeat, that shared heartbeat retains its own lifecycle.

Author watchers around **actionable state**, not only success: a watcher that goes quiet when its check fails or times out looks healthy while broken. Compare the observation with `trigger.state` and return fresh state to deduplicate; do not rely on model or process memory. When firing, make `message` self-contained because it becomes the fired run's complete event context.

<Warning>
Condition-trigger scripts and `script` payloads run unattended by default with the owning agent's **full tool policy, including `exec`**. Stream schedules also keep operator-authored commands running unattended. Treat these surfaces as unattended code execution with that agent's permissions. Operators who need a hard stop can set `cron.triggers.enabled: false`; remove it or set it to `true` to re-enable them.
</Warning>

Create a watcher from a local script file (`-` reads the script from stdin):

```bash
openclaw automations add \
  --name "PR CI watcher" \
  --every 30s \
  --trigger-script ./watch-pr-ci.js \
  --message "Respond to the CI status change" \
  --session isolated
```
