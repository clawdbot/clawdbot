---
summary: "RFC: Cron jobs + wakeups for Clawd/Clawdbot (main vs isolated sessions)"
read_when:
  - Designing scheduled jobs, alarms, or wakeups
  - Adding Gateway methods or CLI commands for automation
  - Adjusting heartbeat behavior or session routing
---

# RFC: Cron jobs + wakeups for Clawd

Status: Draft  
Last updated: 2025-12-13

## Context

Clawdbot already has:
- A **gateway heartbeat runner** that runs the agent with `HEARTBEAT` and suppresses `HEARTBEAT_OK` (`src/infra/heartbeat-runner.ts`).
- A lightweight, in-memory **system event queue** (`enqueueSystemEvent`) that is injected into the next **main session** turn (`drainSystemEvents` in `src/auto-reply/reply.ts`).
- A WebSocket **Gateway** daemon that is intended to be always-on (`docs/gateway.md`).

This RFC adds a small “cron job system” so Clawd can schedule future work and reliably wake itself up:
- **Delayed**: run on the *next* normal heartbeat tick
- **Immediate**: run *now* (trigger a heartbeat immediately)
- **Isolated jobs**: optionally run in their own session that does not pollute the main session and can run concurrently (within configured limits).

## Goals

- Provide a **persistent job store** and an **in-process scheduler** owned by the Gateway.
- Allow each job to target either:
  - `sessionTarget: "main"`: inject as `System:` lines and rely on the main heartbeat (or trigger it immediately).
  - `sessionTarget: "isolated"`: run an agent turn in a dedicated session key (job session), optionally delivering a message and/or posting a summary back to main.
- Expose a stable control surface:
  - **Gateway methods** (`cron.*`, `wake`) for programmatic usage (mac app, CLI, agents).
  - **CLI commands** (`clawdbot cron ...`) to add/remove/edit/list and to debug `run`.
- Produce clear, structured **logs** for job lifecycle and execution outcomes.

## Non-goals (v1)

- Multi-host distributed scheduling.
- Exactly-once semantics across crashes (we aim for “at-least-once with idempotency hooks”).
- A full Unix-cron parser as the only schedule format (we can support it, but v1 should not require complex cron features to be useful).

## Terminology

- **Wake**: a request to ensure the agent gets a turn soon (either right now or next heartbeat).
- **Main session**: the canonical session bucket (default key `"main"`) that receives `System:` events.
- **Isolated session**: a per-job session key (e.g. `cron:<jobId>`) with its own session id / session file.

## User stories

- “Remind me in 20 minutes” → add a one-shot job that triggers an immediate heartbeat at T+20m.
- “Every weekday at 7:30, wake me up and start music” → recurring job, isolated session, deliver to WhatsApp.
- “Every hour, check battery; only interrupt me if < 20%” → isolated job that decides whether to deliver; may also post a brief status to main.
- “Next heartbeat, please check calendar” → delayed wake targeting main session.

## Job model

### Storage schema (v1)

Each job is a JSON object with stable keys (unknown keys ignored for forward compatibility):

- `id: string` (UUID)
- `name: string` (required)
- `description?: string` (optional)
- `enabled: boolean`
- `createdAtMs: number`
- `updatedAtMs: number`
- `schedule` (one of)
  - `{"kind":"at","atMs":number}` (one-shot)
  - `{"kind":"every","everyMs":number,"anchorMs"?:number}` (simple interval)
  - `{"kind":"cron","expr":string,"tz"?:string}` (optional; see “Schedule parsing”)
- `sessionTarget: "main" | "isolated"`
- `wakeMode: "next-heartbeat" | "now"`
  - For `sessionTarget:"isolated"`, `wakeMode:"now"` means “run immediately when due”.
  - For `sessionTarget:"main"`, `wakeMode` controls whether we trigger the heartbeat immediately or just enqueue and wait.
- `payload` (one of)
  - `{"kind":"systemEvent","text":string}` (enqueue as `System:`)
  - `{"kind":"agentTurn","message":string,"deliver"?:boolean,"channel"?: "last"|"whatsapp"|"telegram"|"discord"|"signal"|"imessage","to"?:string,"timeoutSeconds"?:number}`
- `isolation` (optional; only meaningful for isolated jobs)
  - `{"postToMainPrefix"?: string}`
- `runtime` (optional)
  - `{"maxAttempts"?:number,"retryBackoffMs"?:number}` (best-effort retries; defaults off)
- `state` (runtime-maintained)
  - `{"nextRunAtMs":number,"lastRunAtMs"?:number,"lastStatus"?: "ok"|"error"|"skipped","lastError"?:string,"lastDurationMs"?:number}`

### Key behavior

- `sessionTarget:"main"` jobs always enqueue `payload.kind:"systemEvent"` (directly or derived from `agentTurn` results; see below).
- `sessionTarget:"isolated"` jobs create/use a stable session key: `cron:<jobId>`.

## Storage location

Cron persists everything under `~/.clawdbot/cron/`:
- Job store: `~/.clawdbot/cron/jobs.json`
- Run history: `~/.clawdbot/cron/runs/<jobId>.jsonl`

You can override the job store path via `cron.store` in config.

The scheduler should never require additional configuration for the base directory (Clawdbot already treats `~/.clawdbot` as fixed).

## Enabling

Cron execution is enabled by default inside the Gateway.

To disable it, set:

```json5
{
  cron: {
    enabled: false,
    // optional:
    store: "~/.clawdbot/cron/jobs.json",
    maxConcurrentRuns: 1
  }
}
```

You can also disable scheduling via the environment variable `CLAWDBOT_SKIP_CRON=1`.

## Scheduler design

### Ownership

The Gateway owns:
- the scheduler timer,
- job store reads/writes,
- job execution (enqueue system events and/or agent turns).

This keeps scheduling unified with the always-on process and prevents “two schedulers” when multiple CLIs run.

### Timer strategy

- Maintain an in-memory heap/array of enabled jobs keyed by `state.nextRunAtMs`.
- Use a **single `setTimeout`** to wake at the earliest next run.
- On wake:
  - compute all due jobs (now >= nextRunAtMs),
  - mark them “in flight” (in memory),
  - persist updated `state` (at least bump `nextRunAtMs` / `lastRunAtMs`) before starting execution to minimize duplicate runs on crash,
  - execute jobs (with concurrency limits),
  - persist final `lastStatus/lastError/lastDurationMs`,
  - re-arm timer for the next earliest run.

### Schedule parsing

V1 can ship with `at` + `every` without extra deps.

If we add `"kind":"cron"`:
- Use a well-maintained parser (we use `croner`) and support:
  - 5-field cron (`min hour dom mon dow`) at minimum
  - optional `tz`
- Store `nextRunAtMs` computed by the parser; re-compute after each run.

## Execution semantics

### Main session jobs

Main session jobs do not run the agent directly by default.

When due:
1) `enqueueSystemEvent(job.payload.text)` (or a derived message)
2) If `wakeMode:"now"`, trigger an immediate heartbeat run (see “Heartbeat wake hook”).
3) Otherwise do nothing else (the next scheduled heartbeat will pick up the system event).

Why: This keeps the main session’s “proactive” behavior centralized in the heartbeat rules and avoids ad-hoc agent turns that might fight with inbound message processing.

### Isolated session jobs

Isolated jobs run an agent turn in a dedicated session key, intended to be separate from main.

When due:
- Build a message body that includes schedule metadata, e.g.:
  - `"[cron:<jobId>] <job.name>: <payload.message>"`
- Execute via the same agent runner path as other command-mode runs, but pinned to:
  - `sessionKey = cron:<jobId>`
  - `sessionId = store[sessionKey].sessionId` (create if missing)
- Optionally deliver output (`payload.deliver === true`) to the configured channel/to.
- Isolated jobs always enqueue a summary system event to the main session when they finish (derived from the last agent text output).
  - Prefix defaults to `Cron`, and can be customized via `isolation.postToMainPrefix`.
- If `deliver` is omitted/false, nothing is sent to external providers; you still get the main-session summary and can inspect the full isolated transcript in `cron:<jobId>`.

### “Run in parallel to main”

Clawdbot currently serializes command execution through a global in-process queue (`src/process/command-queue.ts`) to avoid collisions.

To support isolated cron jobs running “in parallel”, we should introduce **lanes** (keyed queues) plus a global concurrency cap:
- Lane `"main"`: inbound auto-replies + main heartbeat.
- Lane `"cron"` (or `cron:<jobId>`): isolated jobs.
- Configurable `cron.maxConcurrentRuns` (default 1 or 2).

This yields:
- isolated jobs can overlap with the main lane (up to cap),
- each lane still preserves ordering for its own work (optional),
- we retain safety knobs to prevent runaway resource contention.

## Heartbeat wake hook (immediate vs next heartbeat)

We need a way for the Gateway (or the scheduler) to request an immediate heartbeat without duplicating heartbeat logic.

Design:
- `startHeartbeatRunner` owns the real heartbeat execution and installs a wake handler.
- Wake hook lives in `src/infra/heartbeat-wake.ts`:
  - `setHeartbeatWakeHandler(fn | null)` installed by the heartbeat runner
  - `requestHeartbeatNow({ reason, coalesceMs? })`
- If the handler is absent, the request is stored as “pending”; the next time the handler is installed, it runs once.
- Coalesce rapid calls and respect the “skip when queue busy” behavior (retry soon vs dropping).

## Run history log (JSONL)

In addition to normal structured logs, the Gateway writes an append-only run history “ledger” (JSONL) whenever a job finishes. This is intended for quick debugging (“did the job run, when, and what happened?”).

Path rules:
- Run logs are stored per job next to the store: `.../runs/<jobId>.jsonl`.

Retention:
- Best-effort pruning when the file grows beyond ~2MB; keep the newest ~2000 lines.

Each log line includes (at minimum) job id, status/error, timing, and a `summary` string (systemEvent text for main jobs, and the last agent text output for isolated jobs).

## Compatibility policy (cron.add/cron.update)

To keep older clients working, the Gateway applies **best-effort normalization** for `cron.add` and `cron.update`:
- Accepts wrapped payloads under `data` or `job` and unwraps them.
- Infers `schedule.kind` from `atMs`, `everyMs`, or `expr` if missing.
- Infers `payload.kind` from `text` (systemEvent) or `message` (agentTurn) if missing.
- Defaults `wakeMode` to `"next-heartbeat"` when omitted.
- Defaults `sessionTarget` based on payload kind (`systemEvent` → `"main"`, `agentTurn` → `"isolated"`).

Normalization is **compat-only**. New clients should send the full schema (including `kind`, `sessionTarget`, and `wakeMode`) to avoid ambiguity. Unknown fields are still rejected by schema validation.

## Gateway API

New methods (names can be bikeshed; `cron.*` is suggested):

- `wake`
  - params: `{ mode: "now" | "next-heartbeat", text: string }`
  - effect: `enqueueSystemEvent(text)`, plus optional immediate heartbeat trigger

- `cron.list`
  - params: optional `{ includeDisabled?: boolean }`
  - returns: `{ jobs: CronJob[] }`

- `cron.add`
  - params: job payload without `id/state` (server generates and returns created job)

- `cron.update`
  - params: `{ id: string, patch: Partial<CronJobWritableFields> }`

- `cron.remove`
  - params: `{ id: string }`

- `cron.run`
  - params: `{ id: string, mode?: "due" | "force" }` (debugging; does not change schedule unless `force` requires it)

- `cron.runs`
  - params: `{ id: string, limit?: number }`
  - returns: `{ entries: CronRunLogEntry[] }`
  - note: `id` is required (runs are stored per-job).

The Gateway should broadcast a `cron` event for UI/debug:
- event: `cron`
  - payload: `{ jobId, action: "added"|"updated"|"removed"|"started"|"finished", status?, error?, nextRunAtMs? }`

## CLI surface

Add a `cron` command group (all commands should also support `--json` where sensible):

- `clawdbot cron list [--json] [--all]`
- `clawdbot cron add ...`
  - schedule flags:
    - `--at <iso8601|ms|relative>` (one-shot)
    - `--every <duration>` (e.g. `10m`, `1h`)
    - `--cron "<expr>" [--tz "<tz>"]`
  - target flags:
    - `--session main|isolated`
    - `--wake now|next-heartbeat`
  - payload flags (choose one):
    - `--system-event "<text>"`
    - `--message "<agent message>" [--deliver] [--channel last|whatsapp|telegram|discord|slack|signal|imessage] [--to <dest>]`

- `clawdbot cron edit <id> ...` (patch-by-flags, non-interactive)
- `clawdbot cron rm <id>`
- `clawdbot cron enable <id>` / `clawdbot cron disable <id>`
- `clawdbot cron run <id> [--force]` (debug)
- `clawdbot cron runs --id <id> [--limit <n>]` (run history)
- `clawdbot cron status` (scheduler enabled + next wake)

Additionally:
- `clawdbot wake --mode now|next-heartbeat --text "<text>"` as a thin wrapper around `wake` for agents to call.

## Examples

### Run once at a specific time

One-shot reminder that targets the main session and triggers a heartbeat immediately at the scheduled time:

```bash
clawdbot cron add \
  --at "2025-12-14T07:00:00-08:00" \
  --session main \
  --wake now \
  --system-event "Alarm: wake up (meeting in 30 minutes)."
```

### Run daily (calendar-accurate)

Daily at 07:00 in a specific timezone (preferred over “every 24h” to avoid DST drift):

```bash
clawdbot cron add \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --wake now \
  --message "Daily check: scan calendar + inbox; deliver only if urgent." \
  --deliver \
  --channel last
```

### Run weekly (every Wednesday)

Every Wednesday at 09:00:

```bash
clawdbot cron add \
  --cron "0 9 * * 3" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --wake now \
  --message "Weekly: summarize status and remind me of goals." \
  --deliver \
  --channel last
```

### “Next heartbeat”

Enqueue a note for the main session but let the existing heartbeat cadence pick it up:

```bash
clawdbot wake --mode next-heartbeat --text "Next heartbeat: check battery + upcoming meetings."
```

## Logging & observability

Logging requirements:
- Use `getChildLogger({ module: "cron", jobId, runId, name })` for every run.
- Log lifecycle:
  - store load/save (debug; include job count)
  - schedule recompute (debug; include nextRunAt)
  - job start/end (info)
  - job skipped (info; include reason)
  - job error (warn; include error + stack where available)
- Emit a concise user-facing line to stdout when running in CLI mode (similar to heartbeat logs).

Suggested log events:
- `cron: scheduler started` (jobCount, nextWakeAt)
- `cron: job started` (jobId, scheduleKind, sessionTarget, wakeMode)
- `cron: job finished` (status, durationMs, nextRunAtMs)
- When `cron.enabled` is false, the Gateway logs `cron: disabled` and jobs will not run automatically (the CLI warns on `cron add`/`cron edit`).
- Use `clawdbot cron status` to confirm the scheduler is enabled and see the next wake time.

## Safety & security

- Respect existing allowlists/routing rules: delivery defaults should not send to arbitrary destinations unless explicitly configured.
- Provide a global “kill switch”:
  - `cron.enabled: boolean` (default `true`).
  - `gateway method set-heartbeats` already exists; cron should have similar.
- Avoid persistence of sensitive payloads unless requested; job text may contain private content.

## Testing plan (v1)

- Unit tests:
  - schedule computation for `at` and `every`
  - job store read/write + migration behavior
  - lane concurrency: main vs cron overlap is bounded
  - “wake now” coalescing and pending behavior when provider not ready
- Integration tests:
  - start Gateway with `CLAWDBOT_SKIP_PROVIDERS=1`, add jobs, list/edit/remove
  - simulate due jobs and assert `enqueueSystemEvent` called + cron events broadcast

## Rollout plan

1) Add the `wake` primitive + heartbeat wake hook (no persistent jobs yet).
2) Add `cron.*` API and CLI wrappers with `at` + `every`.
3) Add optional cron expression parsing (`kind:"cron"`) if needed.
4) Add UI surfacing in WebChat/macOS app (optional).
