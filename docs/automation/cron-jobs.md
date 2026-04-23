---
summary: "Scheduled jobs, webhooks, and Gmail PubSub triggers for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring external triggers (webhooks, Gmail) into OpenClaw
  - Deciding between heartbeat and cron for scheduled tasks
title: "Scheduled tasks"
---

# Scheduled Tasks (Cron)

Cron is the Gateway's built-in scheduler. It persists jobs, wakes the agent at the right time, and can deliver output back to a chat channel or webhook endpoint.

## Quick start

```bash
# Add a one-shot reminder
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

# Check your jobs
openclaw cron list
openclaw cron show <job-id>

# See run history
openclaw cron runs --id <job-id>
```

## How cron works

- Cron runs **inside the Gateway** process (not inside the model).
- Job definitions persist at `~/.openclaw/cron/jobs.json` so restarts do not lose schedules.
- Runtime execution state persists next to it in `~/.openclaw/cron/jobs-state.json`. If you track cron definitions in git, track `jobs.json` and gitignore `jobs-state.json`.
- After the split, older OpenClaw versions can read `jobs.json` but may treat jobs as fresh because runtime fields now live in `jobs-state.json`.
- All cron executions create [background task](/automation/tasks) records.
- One-shot jobs (`--at`) auto-delete after success by default.
- Isolated cron runs best-effort close tracked browser tabs/processes for their `cron:<jobId>` session when the run completes, so detached browser automation does not leave orphaned processes behind.
- Isolated cron runs also guard against stale acknowledgement replies. If the
  first result is just an interim status update (`on it`, `pulling everything
together`, and similar hints) and no descendant subagent run is still
  responsible for the final answer, OpenClaw re-prompts once for the actual
  result before delivery.

<a id="maintenance"></a>

Task reconciliation for cron is runtime-owned: an active cron task stays live while the
cron runtime still tracks that job as running, even if an old child session row still exists.
Once the runtime stops owning the job and the 5-minute grace window expires, maintenance can
mark the task `lost`.

## Schedule types

| Kind    | CLI flag  | Description                                             |
| ------- | --------- | ------------------------------------------------------- |
| `at`    | `--at`    | One-shot timestamp (ISO 8601 or relative like `20m`)    |
| `every` | `--every` | Fixed interval                                          |
| `cron`  | `--cron`  | 5-field or 6-field cron expression with optional `--tz` |

Timestamps without a timezone are treated as UTC. Add `--tz America/New_York` for local wall-clock scheduling.

Recurring top-of-hour expressions are automatically staggered by up to 5 minutes to reduce load spikes. Use `--exact` to force precise timing or `--stagger 30s` for an explicit window.

### Day-of-month and day-of-week use OR logic

Cron expressions are parsed by [croner](https://github.com/Hexagon/croner). When both the day-of-month and day-of-week fields are non-wildcard, croner matches when **either** field matches — not both. This is standard Vixie cron behavior.

```
# Intended: "9 AM on the 15th, only if it's a Monday"
# Actual:   "9 AM on every 15th, AND 9 AM on every Monday"
0 9 15 * 1
```

This fires ~5–6 times per month instead of 0–1 times per month. OpenClaw uses Croner's default OR behavior here. To require both conditions, use Croner's `+` day-of-week modifier (`0 9 15 * +1`) or schedule on one field and guard the other in your job's prompt or command.

## Execution styles

| Style           | `--session` value   | Runs in                  | Best for                        |
| --------------- | ------------------- | ------------------------ | ------------------------------- |
| Main session    | `main`              | Next heartbeat turn      | Reminders, system events        |
| Isolated        | `isolated`          | Dedicated `cron:<jobId>` | Reports, background chores      |
| Current session | `current`           | Bound at creation time   | Context-aware recurring work    |
| Custom session  | `session:custom-id` | Persistent named session | Workflows that build on history |

**Main session** jobs enqueue a system event and optionally wake the heartbeat (`--wake now` or `--wake next-heartbeat`). **Isolated** jobs run a dedicated agent turn with a fresh session. **Custom sessions** (`session:xxx`) persist context across runs, enabling workflows like daily standups that build on previous summaries.

For isolated jobs, runtime teardown now includes best-effort browser cleanup for that cron session. Cleanup failures are ignored so the actual cron result still wins.

Isolated cron runs also dispose any bundled MCP runtime instances created for the job through the shared runtime-cleanup path. This matches how main-session and custom-session MCP clients are torn down, so isolated cron jobs do not leak stdio child processes or long-lived MCP connections across runs.

When isolated cron runs orchestrate subagents, delivery also prefers the final
descendant output over stale parent interim text. If descendants are still
running, OpenClaw suppresses that partial parent update instead of announcing it.

### Payload options for isolated jobs

- `--message`: prompt text (required for isolated)
- `--model` / `--thinking`: model and thinking level overrides
- `--light-context`: skip workspace bootstrap file injection
- `--tools exec,read`: restrict which tools the job can use

`--model` uses the selected allowed model for that job. If the requested model
is not allowed, cron logs a warning and falls back to the job's agent/default
model selection instead. Configured fallback chains still apply, but a plain
model override with no explicit per-job fallback list no longer appends the
agent primary as a hidden extra retry target.

Model-selection precedence for isolated jobs is:

1. Gmail hook model override (when the run came from Gmail and that override is allowed)
2. Per-job payload `model`
3. Stored cron session model override
4. Agent/default model selection

Fast mode follows the resolved live selection too. If the selected model config
has `params.fastMode`, isolated cron uses that by default. A stored session
`fastMode` override still wins over config in either direction.

If an isolated run hits a live model-switch handoff, cron retries with the
switched provider/model and persists that live selection before retrying. When
the switch also carries a new auth profile, cron persists that auth profile
override too. Retries are bounded: after the initial attempt plus 2 switch
retries, cron aborts instead of looping forever.

## Delivery and output

| Mode       | What happens                                                        |
| ---------- | ------------------------------------------------------------------- |
| `announce` | Fallback-deliver final text to the target if the agent did not send |
| `webhook`  | POST finished event payload to a URL                                |
| `none`     | No runner fallback delivery                                         |

Use `--announce --channel telegram --to "-1001234567890"` for channel delivery. For Telegram forum topics, use `-1001234567890:topic:123`. Slack/Discord/Mattermost targets should use explicit prefixes (`channel:<id>`, `user:<id>`).

For isolated jobs, chat delivery is shared. If a chat route is available, the
agent can use the `message` tool even when the job uses `--no-deliver`. If the
agent sends to the configured/current target, OpenClaw skips the fallback
announce. Otherwise `announce`, `webhook`, and `none` only control what the
runner does with the final reply after the agent turn.

Failure notifications follow a separate destination path:

- `cron.failureDestination` sets a global default for failure notifications.
- `job.delivery.failureDestination` overrides that per job.
- If neither is set and the job already delivers via `announce`, failure notifications now fall back to that primary announce target.
- `delivery.failureDestination` is only supported on `sessionTarget="isolated"` jobs unless the primary delivery mode is `webhook`.

## CLI examples

One-shot reminder (main session):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Recurring isolated job with delivery:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

Isolated job with model and thinking override:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce
```

## Webhooks

Gateway can expose HTTP webhook endpoints for external triggers. Enable in config:

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

### Authentication

Every request must include the hook token via header:

- `Authorization: Bearer <token>` (recommended)
- `x-openclaw-token: <token>`

Query-string tokens are rejected.

### POST /hooks/wake

Enqueue a system event for the main session:

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

- `text` (required): event description
- `mode` (optional): `now` (default) or `next-heartbeat`

### POST /hooks/agent

Run an isolated agent turn:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.5"}'
```

Fields: `message` (required), `name`, `agentId`, `wakeMode`, `deliver`, `channel`, `to`, `model`, `thinking`, `timeoutSeconds`.

### Mapped hooks (POST /hooks/\<name\>)

Custom hook names are resolved via `hooks.mappings` in config. Mappings can transform arbitrary payloads into `wake` or `agent` actions with templates or code transforms.

### Security

- Keep hook endpoints behind loopback, tailnet, or trusted reverse proxy.
- Use a dedicated hook token; do not reuse gateway auth tokens.
- Keep `hooks.path` on a dedicated subpath; `/` is rejected.
- Set `hooks.allowedAgentIds` to limit explicit `agentId` routing.
- Keep `hooks.allowRequestSessionKey=false` unless you require caller-selected sessions.
- If you enable `hooks.allowRequestSessionKey`, also set `hooks.allowedSessionKeyPrefixes` to constrain allowed session key shapes.
- Hook payloads are wrapped with safety boundaries by default.

## Gmail PubSub integration

Wire Gmail inbox triggers to OpenClaw via Google PubSub.

**Prerequisites**: `gcloud` CLI, `gog` (gogcli), OpenClaw hooks enabled, Tailscale for the public HTTPS endpoint.

### Wizard setup (recommended)

```bash
openclaw webhooks gmail setup --account openclaw@gmail.com
```

This writes `hooks.gmail` config, enables the Gmail preset, and uses Tailscale Funnel for the push endpoint.

### Gateway auto-start

When `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts `gog gmail watch serve` on boot and auto-renews the watch. Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to opt out.

### Manual one-time setup

1. Select the GCP project that owns the OAuth client used by `gog`:

```bash
gcloud auth login
gcloud config set project <project-id>
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

2. Create topic and grant Gmail push access:

```bash
gcloud pubsub topics create gog-gmail-watch
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

3. Start the watch:

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

### Gmail model override

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

## Managing jobs

```bash
# List all jobs
openclaw cron list

# Show one job, including resolved delivery route
openclaw cron show <jobId>

# Edit a job
openclaw cron edit <jobId> --message "Updated prompt" --model "opus"

# Force run a job now
openclaw cron run <jobId>

# Run only if due
openclaw cron run <jobId> --due

# View run history
openclaw cron runs --id <jobId> --limit 50

# Delete a job
openclaw cron remove <jobId>

# Agent selection (multi-agent setups)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops
openclaw cron edit <jobId> --clear-agent
```

Model override note:

- `openclaw cron add|edit --model ...` changes the job's selected model.
- If the model is allowed, that exact provider/model reaches the isolated agent
  run.
- If it is not allowed, cron warns and falls back to the job's agent/default
  model selection.
- Configured fallback chains still apply, but a plain `--model` override with
  no explicit per-job fallback list no longer falls through to the agent
  primary as a silent extra retry target.

## Configuration

```json5
{
  cron: {
    enabled: true,
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1,
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 120000, 300000],
      retryOn: ["rate_limit", "overloaded", "network", "server_error"],
    },
    webhookToken: "replace-with-dedicated-webhook-token",
    sessionRetention: "24h",
    runLog: { maxBytes: "2mb", keepLines: 2000 },
  },
}
```

The runtime state sidecar is derived from `cron.store`: a `.json` store such as
`~/clawd/cron/jobs.json` uses `~/clawd/cron/jobs-state.json`, while a store path
without a `.json` suffix appends `-state.json`.

Disable cron: `cron.enabled: false` or `OPENCLAW_SKIP_CRON=1`.

**One-shot retry**: transient errors (rate limit, overload, network, server error) retry up to 3 times with exponential backoff. Permanent errors disable immediately.

**Recurring retry**: exponential backoff (30s to 60m) between retries. Backoff resets after the next successful run.

**Maintenance**: `cron.sessionRetention` (default `24h`) prunes isolated run-session entries. `cron.runLog.maxBytes` / `cron.runLog.keepLines` auto-prune run-log files.

## Troubleshooting

### Command ladder

```bash
openclaw status
openclaw gateway status
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
openclaw doctor
```

### Cron not firing

- Check `cron.enabled` and `OPENCLAW_SKIP_CRON` env var.
- Confirm the Gateway is running continuously.
- For `cron` schedules, verify timezone (`--tz`) vs the host timezone.
- `reason: not-due` in run output means manual run was checked with `openclaw cron run <jobId> --due` and the job was not due yet.

### Cron fired but no delivery

- Delivery mode `none` means no runner fallback send is expected. The agent can
  still send directly with the `message` tool when a chat route is available.
- Delivery target missing/invalid (`channel`/`to`) means outbound was skipped.
- Channel auth errors (`unauthorized`, `Forbidden`) mean delivery was blocked by credentials.
- If the isolated run returns only the silent token (`NO_REPLY` / `no_reply`),
  OpenClaw suppresses direct outbound delivery and also suppresses the fallback
  queued summary path, so nothing is posted back to chat.
- If the agent should message the user itself, check that the job has a usable
  route (`channel: "last"` with a previous chat, or an explicit channel/target).

### Timezone gotchas

- Cron without `--tz` uses the gateway host timezone.
- `at` schedules without timezone are treated as UTC.
- Heartbeat `activeHours` uses configured timezone resolution.

## Related

- [Automation & Tasks](/automation) — all automation mechanisms at a glance
- [Background Tasks](/automation/tasks) — task ledger for cron executions
- [Heartbeat](/gateway/heartbeat) — periodic main-session turns
- [Timezone](/concepts/timezone) — timezone configuration
