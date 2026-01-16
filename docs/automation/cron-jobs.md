---
summary: "Cron jobs + wakeups for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring automation that should run with or alongside heartbeats
---
# Cron jobs (Gateway scheduler)

Cron is the Gateway’s built-in scheduler. It persists jobs, wakes the agent at
the right time, and can optionally deliver output back to a chat.

If you want *“run this every morning”* or *“poke the agent in 20 minutes”*,
cron is the mechanism.

## TL;DR
- Cron runs **inside the Gateway** (not inside the model).
- Jobs persist under `~/.clawdbot/cron/` so restarts don’t lose schedules.
- Two execution styles:
  - **Main session**: enqueue a system event, then run on the next heartbeat.
  - **Isolated**: run a dedicated agent turn in `cron:<jobId>`, optionally deliver output.
- Wakeups are first-class: a job can request “wake now” vs “next heartbeat”.

## Beginner-friendly overview
Think of a cron job as: **when** to run + **what** to do.

1) **Choose a schedule**
   - One-shot reminder → `schedule.kind = "at"` (CLI: `--at`)
   - Repeating job → `schedule.kind = "every"` or `schedule.kind = "cron"`
   - If your ISO timestamp omits a timezone, it is treated as **UTC**.

2) **Choose where it runs**
   - `sessionTarget: "main"` → run during the next heartbeat with main context.
   - `sessionTarget: "isolated"` → run a dedicated agent turn in `cron:<jobId>`.

3) **Choose the payload**
   - Main session → `payload.kind = "systemEvent"`
   - Isolated session → `payload.kind = "agentTurn"`

Optional: `deleteAfterRun: true` removes successful one-shot jobs from the store.

## Concepts

### Jobs
A cron job is a stored record with:
- a **schedule** (when it should run),
- a **payload** (what it should do),
- optional **delivery** (where output should be sent).
- optional **agent binding** (`agentId`): run the job under a specific agent; if
  missing or unknown, the gateway falls back to the default agent.

Jobs are identified by a stable `jobId` (used by CLI/Gateway APIs).
In agent tool calls, `jobId` is canonical; legacy `id` is accepted for compatibility.
Jobs can optionally auto-delete after a successful one-shot run via `deleteAfterRun: true`.

### Schedules
Cron supports three schedule kinds:
- `at`: one-shot timestamp (ms since epoch). Gateway accepts ISO 8601 and coerces to UTC.
- `every`: fixed interval (ms).
- `cron`: 5-field cron expression with optional IANA timezone.

Cron expressions use `croner`. If a timezone is omitted, the Gateway host’s
local timezone is used.

### Main vs isolated execution

#### Main session jobs (system events)
Main jobs enqueue a system event and optionally wake the heartbeat runner.
They must use `payload.kind = "systemEvent"`.

- `wakeMode: "next-heartbeat"` (default): event waits for the next scheduled heartbeat.
- `wakeMode: "now"`: event triggers an immediate heartbeat run.

This is the best fit when you want the normal heartbeat prompt + main-session context.
See [Heartbeat](/gateway/heartbeat).

#### Isolated jobs (dedicated cron sessions)
Isolated jobs run a dedicated agent turn in session `cron:<jobId>`.

Key behaviors:
- Prompt is prefixed with `[cron:<jobId> <job name>]` for traceability.
- Each run starts a **fresh session id** (no prior conversation carry-over).
- A summary is posted to the main session (prefix `Cron`, configurable).
- `wakeMode: "now"` triggers an immediate heartbeat after posting the summary.
- If `payload.deliver: true`, output is delivered to a channel; otherwise it stays internal.

Use isolated jobs for noisy, frequent, or "background chores" that shouldn't spam
your main chat history.

### Payload shapes (what runs)
Two payload kinds are supported:
- `systemEvent`: main-session only, routed through the heartbeat prompt.
- `agentTurn`: isolated-session only, runs a dedicated agent turn.

Common `agentTurn` fields:
- `message`: required text prompt.
- `model` / `thinking`: optional overrides (see below).
- `timeoutSeconds`: optional timeout override.
- `deliver`: `true` to send output to a channel target.
- `channel`: `last` or a specific channel.
- `to`: channel-specific target (phone/chat/channel id).
- `bestEffortDeliver`: avoid failing the job if delivery fails.

Isolation options (only for `session=isolated`):
- `postToMainPrefix` (CLI: `--post-prefix`): prefix for the summary system event in main.

### Model and thinking overrides
Isolated jobs (`agentTurn`) can override the model and thinking level:
- `model`: Provider/model string (e.g., `anthropic/claude-sonnet-4-20250514`) or alias (e.g., `opus`)
- `thinking`: Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex models only)

Note: You can set `model` on main-session jobs too, but it changes the shared main
session model. We recommend model overrides only for isolated jobs to avoid
unexpected context shifts.

Resolution priority:
1. Job payload override (highest)
2. Hook-specific defaults (e.g., `hooks.gmail.model`)
3. Agent config default

### Delivery (channel + target)
Isolated jobs can deliver output to a channel. The job payload can specify:
- `channel`: `whatsapp` / `telegram` / `discord` / `slack` / `signal` / `imessage` / `last`
- `to`: channel-specific recipient target

If `channel` or `to` is omitted, cron can fall back to the main session’s “last route”
(the last place the agent replied).

Target format reminders:
- Slack/Discord targets should use explicit prefixes (e.g. `channel:<id>`, `user:<id>`) to avoid ambiguity.
- Telegram topics should use the `:topic:` form (see below).

#### Telegram delivery targets (topics / forum threads)
Telegram supports forum topics via `message_thread_id`. For cron delivery, you can encode
the topic/thread into the `to` field:

- `-1001234567890` (chat id only)
- `-1001234567890:topic:123` (preferred: explicit topic marker)
- `-1001234567890:123` (shorthand: numeric suffix)

Prefixed targets like `telegram:...` / `telegram:group:...` are also accepted:
- `telegram:group:-1001234567890:topic:123`

## Storage & history
- Job store: `~/.clawdbot/cron/jobs.json` (Gateway-managed JSON).
- Run history: `~/.clawdbot/cron/runs/<jobId>.jsonl` (JSONL, auto-pruned).
- Override store path: `cron.store` in config.

## Configuration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.clawdbot/cron/jobs.json",
    maxConcurrentRuns: 1 // default 1
  }
}
```

Disable cron entirely:
- `cron.enabled: false` (config)
- `CLAWDBOT_SKIP_CRON=1` (env)

## CLI quickstart

One-shot reminder (UTC ISO, auto-delete after success):
```bash
clawdbot cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

One-shot reminder (main session, wake immediately):
```bash
clawdbot cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Recurring isolated job (deliver to WhatsApp):
```bash
clawdbot cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --deliver \
  --channel whatsapp \
  --to "+15551234567"
```

Recurring isolated job (deliver to a Telegram topic):
```bash
clawdbot cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --deliver \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Isolated job with model and thinking override:
```bash
clawdbot cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --deliver \
  --channel whatsapp \
  --to "+15551234567"

Agent selection (multi-agent setups):
```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
clawdbot cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
clawdbot cron edit <jobId> --agent ops
clawdbot cron edit <jobId> --clear-agent
```
```

Manual run (debug):
```bash
clawdbot cron run <jobId> --force
```

Edit an existing job (patch fields):
```bash
clawdbot cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Run history:
```bash
clawdbot cron runs --id <jobId> --limit 50
```

Immediate wake without creating a job:
```bash
clawdbot wake --mode now --text "Next heartbeat: check battery."
```

## Gateway API surface
- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force or due), `cron.runs`
- `wake` (enqueue system event + optional heartbeat)

## Troubleshooting

### “Nothing runs”
- Check cron is enabled: `cron.enabled` and `CLAWDBOT_SKIP_CRON`.
- Check the Gateway is running continuously (cron runs inside the Gateway process).
- For `cron` schedules: confirm timezone (`--tz`) vs the host timezone.

### Telegram delivers to the wrong place
- For forum topics, use `-100…:topic:<id>` so it’s explicit and unambiguous.
- If you see `telegram:...` prefixes in logs or stored “last route” targets, that’s normal;
  cron delivery accepts them and still parses topic IDs correctly.
