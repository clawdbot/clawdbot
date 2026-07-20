---
summary: "Scheduled jobs, webhooks, and Gmail PubSub triggers for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring external triggers (webhooks, Gmail) into OpenClaw
  - Deciding between heartbeat and cron for scheduled tasks
title: "Scheduled tasks"
sidebarTitle: "Scheduled tasks"
---

Cron is the Gateway's built-in scheduler. It persists jobs, wakes the agent at the right time, and can deliver output to a chat channel, a webhook, or nowhere.

## Quick start

<Steps>
  <Step title="Add a one-shot reminder">
    ```bash
    openclaw cron create "2027-02-01T16:00:00Z" \
      --name "Reminder" \
      --session main \
      --system-event "Reminder: check the cron docs draft" \
      --wake now \
      --delete-after-run
    ```
  </Step>
  <Step title="Check your jobs">
    ```bash
    openclaw cron list
    openclaw cron get <job-id>
    openclaw cron show <job-id>
    ```
  </Step>
  <Step title="See run history">
    ```bash
    openclaw cron runs --id <job-id>
    ```
  </Step>
</Steps>

## How cron works

- Cron runs **inside the Gateway process**, not inside the model. The Gateway must be running for schedules to fire.
- Job definitions, runtime state, and run history persist in OpenClaw's shared SQLite state database, so restarts do not lose schedules.
- Every cron execution creates a [background task](/automation/tasks) record.
- One-shot jobs (`--at`) auto-delete after success by default; pass `--keep-after-run` to keep them.
- Per-run wall-clock budget: `--timeout-seconds` when set. Otherwise, isolated/detached agent-turn jobs are bounded by cron's own 60-minute watchdog before the underlying agent-turn timeout (`agents.defaults.timeoutSeconds`, default 48 hours) would ever apply; command jobs default to 10 minutes, and script payloads default to 5 minutes.
- On Gateway startup, overdue isolated agent-turn jobs are rescheduled instead of replayed immediately, keeping model/tool bootstrap work out of the channel-connect window.
- If you drive `openclaw agent` from system cron or another external scheduler, wrap it with a hard-kill escalation even though the CLI already handles `SIGTERM`/`SIGINT`. Gateway-backed runs ask the Gateway to abort accepted runs; local and embedded fallback runs get the same abort signal. For GNU `timeout`, prefer `timeout -k 60 600 openclaw agent ...` over plain `timeout 600 ...` — the `-k` value is the backstop if the process cannot drain in time. For systemd units, use a `SIGTERM` stop signal with a grace window (`TimeoutStopSec`) before the final kill. Reusing a `--run-id` while the original Gateway run is still active reports the duplicate as in-flight instead of starting a second run.

<AccordionGroup>
  <Accordion title="Isolated run hardening">
    - Isolated runs best-effort close tracked browser tabs/processes for their `cron:<jobId>` session on completion, and dispose any bundled MCP runtime instances created for the job through the same shared teardown path used by main-session and custom-session runs. Cleanup failures are ignored so the cron result still wins.
    - Isolated runs with the narrow cron self-cleanup grant can read scheduler status, a self-filtered list containing only their own job, and that job's run history, and may remove only their own job.
    - Isolated runs guard against stale acknowledgement replies: if the first result is only an interim status update (`on it`, `pulling everything together`, and similar hints) and no descendant subagent is still responsible for the final answer, OpenClaw re-prompts once for the actual result before delivery.
    - Structured execution-denial metadata (including node-host `UNAVAILABLE` wrappers whose nested error starts with `SYSTEM_RUN_DENIED` or `INVALID_REQUEST`) is recognized so a blocked command is not reported as a green run, while ordinary assistant prose is not mistaken for a denial.
    - Run-level agent failures count as job errors even with no reply payload, so model/provider failures increment error counters and trigger failure notifications instead of clearing the job as successful.
    - When a job hits `timeoutSeconds`, cron aborts the run and gives it a short cleanup window. If it does not drain, Gateway-owned cleanup force-clears that run's session ownership before cron records the timeout, so queued chat work is not stuck behind a stale processing session.
    - Setup/startup stalls get a phase-specific timeout (for example `cron: isolated agent setup timed out before runner start` or `cron: isolated agent run stalled before execution start (last phase: context-engine)`). These watchdogs cover embedded and CLI-backed providers even before their external CLI process starts, and are capped independently of long `timeoutSeconds` values so cold-start/auth/context failures surface quickly.

  </Accordion>
  <Accordion title="Task reconciliation">
    Cron task reconciliation is runtime-owned first, durable-history-backed second: an active cron task stays live while the cron runtime still tracks that job as running, even if an old child session row still exists. Once the runtime stops owning the job and a 5-minute grace window expires, maintenance checks persisted run logs and job state for the matching `cron:<jobId>:<startedAt>` run. A terminal result there finalizes the task ledger; otherwise Gateway-owned maintenance can mark the task `lost`. Offline CLI audit can recover from durable history, but its own empty in-process active-job set is not proof a Gateway-owned run is gone.
  </Accordion>
</AccordionGroup>

## Schedule types

| Kind      | CLI flag    | Description                                                                                              |
| --------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `at`      | `--at`      | One-shot timestamp (ISO 8601 or relative like `20m`)                                                     |
| `every`   | `--every`   | Fixed interval (`10m`, `1h`, `1d`)                                                                       |
| `cron`    | `--cron`    | 5-field or 6-field cron expression with optional `--tz`                                                  |
| `on-exit` | `--on-exit` | Fire once when a watched command exits (event trigger; survives turn teardown; optional `--on-exit-cwd`) |

Timestamps without a timezone are treated as UTC. Add `--tz America/New_York` to interpret an offset-less `--at` datetime, or to evaluate a cron expression, in that IANA timezone. Cron expressions without `--tz` use the Gateway host timezone. `--tz` is not valid with `--every` or `--on-exit`.

Recurring top-of-hour expressions (minute `0` with a wildcard hour field) are automatically staggered by up to 5 minutes to reduce load spikes. Use `--exact` to force precise timing, or `--stagger 30s` for an explicit window (cron schedules only).

### Dynamic cadence (pacing)

Recurring jobs can set `pacing.min` and/or `pacing.max` to duration strings such as `15m` or `4h`; at least one bound is required. Use `--pacing-min` and `--pacing-max` with `cron add|edit` (`--clear-pacing` removes both bounds).

During an isolated run, a paced job can call the `cron` tool with `action: "next_check"` and `in: "30m"`. The proposal applies only to that currently running job and is measured from successful run completion. OpenClaw silently clamps it to the configured bounds.

Pacing without a proposal leaves the normal schedule unchanged. Failed, timed-out, and skipped runs discard the proposal, so existing retry and error-backoff behavior takes precedence. Manually forcing a recurring job is out-of-band and preserves its pending natural or paced slot. For condition-triggered jobs, the built-in minimum interval remains a lower bound even when a proposal requests an earlier check.

### Day-of-month and day-of-week use OR logic

Cron expressions are parsed by [croner](https://github.com/Hexagon/croner). When both the day-of-month and day-of-week fields are non-wildcard, croner matches when **either** field matches, not both. This is standard Vixie cron behavior.

```bash
# Intended: "9 AM on the 15th, only if it's a Monday"
# Actual:   "9 AM on every 15th, AND 9 AM on every Monday"
0 9 15 * 1
```

This fires roughly 5-6 times a month instead of 0-1 times a month. To require both conditions, use croner's `+` day-of-week modifier (`0 9 15 * +1`), or schedule on one field and guard the other in your job's prompt or command.

## Event triggers (condition watchers)

An event trigger adds a headless condition script to an `every` or `cron` schedule. Cron evaluates the script when the job is due and runs the normal payload only when the script returns `fire: true`:

```json5
{
  schedule: { kind: "every", everyMs: 30000 },
  trigger: {
    // Fires only when the observed status differs from the last evaluation.
    script: "const res = await tools.call('exec', { command: 'gh pr checks 123 --json state -q \\'.[].state\\' | sort -u' }); const status = String(res?.result?.details?.aggregated ?? '').trim(); json({ fire: status !== trigger.state?.status, message: `PR 123 CI: ${trigger.state?.status ?? 'unknown'} -> ${status}`, state: { status } });",
    once: false,
  },
  payload: { kind: "agentTurn", message: "Investigate the CI status change." },
}
```

The script must return `{ fire, message?, state? }`. The previous JSON state is available as the deeply frozen `trigger.state`; return a new `state` value to persist it. State is capped at 16 KB. When a firing result includes `message`, cron appends it to the system-event text or agent-turn message before execution. `once: true` disables the job after its first successful fired payload.

`fire: false` persists evaluation state and counters, then reschedules without creating run history. If a fired payload run fails, the returned `state` is **not** persisted — the next evaluation sees the previous state and can fire again, so write scripts as read-only checks and keep actions in the payload. Trigger schedules have a configurable minimum interval (30 seconds by default). Each evaluation has a 30-second wall-clock budget and up to 5 tool calls.

Author watchers around **actionable state**, not only success: a watcher that goes quiet when its check fails or times out looks healthy while broken. Compare the observation with `trigger.state` and return fresh state to deduplicate; do not rely on model or process memory. When firing, make `message` self-contained because it becomes the fired run's complete event context.

<Warning>
Enabling `cron.triggers.enabled` permits both condition-trigger scripts and `script` payloads to run headlessly with the owning agent's **full tool policy, including `exec`**. Treat this as unattended code execution with that agent's permissions; leave it disabled unless every agent allowed to create cron jobs is trusted accordingly.
</Warning>

Create a watcher from a local script file (`-` reads the script from stdin):

```bash
openclaw cron add \
  --name "PR CI watcher" \
  --every 30s \
  --trigger-script ./watch-pr-ci.js \
  --message "Respond to the CI status change" \
  --session isolated
```

## Payloads

Every job carries exactly one payload kind, chosen by flag:

| Payload       | Flag                                           | Runs                                                       |
| ------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| System event  | `--system-event <text>`                        | Enqueued into the main session, no model call by itself    |
| Agent message | `--message <text>`                             | A model-backed agent turn                                  |
| Command       | `--command <shell>` or `--command-argv <json>` | A shell/process on the Gateway host, no model call         |
| Script        | `--script <file\|->`                           | A headless code-mode script using the owning agent's tools |

### Agent-turn options

<ParamField path="--message" type="string" required>
  Prompt text (required for isolated/current/custom-session jobs).
</ParamField>
<ParamField path="--model" type="string">
  Model override; must resolve to an allowed model or the run fails with a validation error.
</ParamField>
<ParamField path="--fallbacks" type="string">
  Per-job fallback model list, for example `--fallbacks openai/gpt-5.6-sol,openrouter/meta-llama/llama-3.3-70b-instruct:free`. Pass `--fallbacks ""` for a strict run with no fallbacks.
</ParamField>
<ParamField path="--clear-fallbacks" type="boolean">
  On `cron edit`, removes the per-job fallback override so the job follows configured fallback precedence. Cannot combine with `--fallbacks`.
</ParamField>
<ParamField path="--clear-model" type="boolean">
  On `cron edit`, removes the per-job model override so the job follows normal cron model precedence (stored cron-session override, else agent/default model). Cannot combine with `--model`.
</ParamField>
<ParamField path="--thinking" type="string">
  Thinking level override (`off|minimal|low|medium|high|xhigh|adaptive|max|ultra`). Available levels still depend on the selected model and agent runtime.
</ParamField>
<ParamField path="--clear-thinking" type="boolean">
  On `cron edit`, removes the per-job thinking override. Cannot combine with `--thinking`.
</ParamField>
<ParamField path="--light-context" type="boolean">
  Skip workspace bootstrap file injection.
</ParamField>
<ParamField path="--tools" type="string">
  Restrict which tools the job can use, for example `--tools exec,read`.
</ParamField>

`--model` sets the job's primary model; it does not replace a session `/model` override, so configured fallback chains still apply on top of it. An unresolved or disallowed model fails the run with an explicit validation error rather than silently falling back to the default. If a job has `--model` but no explicit or configured fallback list, OpenClaw passes an empty fallback override instead of silently appending the agent primary as a hidden retry target.

Model-selection precedence for isolated jobs, highest first:

1. Per-job payload `model` (explicit config; a disallowed model fails the run)
2. Gmail hook model override (only when the run came from Gmail and that override is allowed)
3. User-selected stored cron-session model override
4. Agent/default model selection

Fast mode follows the resolved live selection. If the selected model config has `params.fastMode`, isolated cron uses it by default; a stored session `fastMode` override (then an agent `fastModeDefault`) still wins over model config either direction. Auto mode uses the model's `params.fastAutoOnSeconds` cutoff, defaulting to 60 seconds.

If a run hits a live model-switch handoff, cron retries with the switched provider/model and persists that selection (and any new auth profile) for the active run. Retries are bounded: after the initial attempt plus 2 switch retries, cron aborts instead of looping.

Before an isolated run starts, OpenClaw checks reachable local endpoints for configured `api: "ollama"` and `api: "openai-completions"` providers whose `baseUrl` is loopback, private-network, or `.local`. This preflight walks the job's configured fallback chain and only marks the run `skipped` once every candidate is unreachable; `--fallbacks ""` keeps that walk strict to just the primary model. A down endpoint records the run as `skipped` with a clear error instead of starting a model call. The result is cached for 5 minutes per endpoint (not per job or model), so many due jobs sharing a dead local Ollama/vLLM/SGLang/LM Studio server cost one probe instead of a request storm. Skipped preflight runs do not increment execution-error backoff; set `failureAlert.includeSkipped` to opt into repeated skip alerts.

### Command payloads

Command payloads run deterministic scripts inside the Gateway scheduler without starting a model-backed turn. They execute on the Gateway host, capture stdout/stderr, record the run in cron history, and reuse the same `announce`, `webhook`, and `none` delivery modes as agent-turn jobs.

<Note>
Command cron is an operator-admin Gateway automation surface, not an agent `tools.exec` call. Creating, updating, removing, or manually running cron jobs requires `operator.admin`; scheduled command runs later execute inside the Gateway process as that admin-authored automation. Agent exec policy (`tools.exec.mode`, approval prompts, per-agent tool allowlists) governs model-visible exec tools, not command cron payloads.
</Note>

```bash
openclaw cron create "*/15 * * * *" \
  --name "Queue depth probe" \
  --command "scripts/check-queue.sh" \
  --command-cwd "/srv/app" \
  --announce \
  --channel telegram \
  --to "-1001234567890"
```

`--command <shell>` stores `argv: ["sh", "-lc", <shell>]`. Use `--command-argv '["node","scripts/report.mjs"]'` for exact argv execution without shell parsing. Optional `--command-env KEY=VALUE` (repeatable), `--command-input`, `--timeout-seconds` (default 10 minutes), `--no-output-timeout-seconds`, and `--output-max-bytes` control the process environment, stdin, and output bounds.

Delivered text is derived from process output: non-empty stdout wins; if stdout is empty and stderr is non-empty, stderr is delivered; if both are present, cron sends a small `stdout:` / `stderr:` block. Exit code `0` records the run `ok`; non-zero exit, signal, timeout, or no-output timeout records `error` and can trigger failure alerts. A command that prints only `NO_REPLY` uses the normal cron silent-token suppression and posts nothing back to chat.

### Script payloads

Script payloads run headlessly in the same code-mode executor as trigger scripts, without starting a conversational agent turn. Enable `cron.triggers.enabled` before creating or running them; this dangerous-automation gate covers both trigger scripts and script payloads. Script jobs support only `main` and `isolated` session targets.

```bash
openclaw cron create "0 * * * *" \
  --name "Hourly queue check" \
  --script ./automation/check-queue.js \
  --script-timeout-seconds 300 \
  --script-tool-budget 50 \
  --session isolated \
  --announce
```

Use `--script <file|->` to read JavaScript from a file or stdin. The timeout defaults to 300 seconds and is capped at 900; the tool budget defaults to 50 calls and is capped at 200. These payload budgets are separate from the smaller trigger-gate evaluation budgets.

The script may return an object with these optional fields:

- `notify`: Text delivered through the job's `announce`, `webhook`, or `none` delivery mode. If omitted, nothing is delivered. For a `main` job, the text becomes a system event.
- `wake`: `"now"` requests an immediate heartbeat after enqueueing `notify` (or a compact completion event); `"next-heartbeat"` enqueues the event for the next heartbeat.
- `state`: JSON state, capped at 16 KB and persisted only after a successful run. The next run receives a frozen copy as `trigger.state`, matching trigger scripts. Because that namespace has one persisted owner, a script payload cannot be combined with a condition trigger on the same job.
- `nextCheck`: A duration such as `"15m"`. It is valid only for jobs with pacing enabled and uses the same pacing clamp as agent-turn proposals.

Throws, timeouts, exhausted tool budgets, invalid results, and `nextCheck` without pacing are normal cron run errors: they enter run history, backoff, and failure-alert handling without persisting returned state.

## Execution styles

| Style           | `--session` value   | Runs in                  | Best for                        |
| --------------- | ------------------- | ------------------------ | ------------------------------- |
| Main session    | `main`              | Dedicated cron wake lane | Reminders, system events        |
| Isolated        | `isolated`          | Dedicated `cron:<jobId>` | Reports, background chores      |
| Current session | `current`           | Bound at creation time   | Context-aware recurring work    |
| Custom session  | `session:custom-id` | Persistent named session | Workflows that build on history |

<AccordionGroup>
  <Accordion title="Main session vs isolated vs custom">
    **Main session** jobs enqueue a system event into a cron-owned run lane and optionally wake the heartbeat (`--wake now` or `--wake next-heartbeat`). They can use the target main session's last delivery context for replies, but do not append routine cron turns to the human chat lane and do not extend daily/idle reset freshness for the target session. **Isolated** jobs run a dedicated agent turn with a fresh session. **Custom sessions** (`session:xxx`) persist context across runs, enabling workflows like daily standups that build on previous summaries.

    Main-session cron events are self-contained system-event reminders. They do not automatically include the default heartbeat prompt's "Read HEARTBEAT.md" instruction; say that explicitly in the cron event text if a reminder should consult `HEARTBEAT.md`.

  </Accordion>
  <Accordion title="What 'fresh session' means for isolated jobs">
    A new transcript/session id per run. OpenClaw carries safe preferences (thinking/fast/verbose settings, labels, explicit user-selected model/auth overrides), but does not inherit ambient conversation context from an older cron row: channel/group routing, send or queue policy, elevation, origin, or ACP runtime binding. Use `current` or `session:<id>` when a recurring job should deliberately build on the same conversation context.
  </Accordion>
  <Accordion title="Unattended run contract">
    Isolated cron and hook agent turns are explicitly unattended: no one is present to clarify or approve. The final reply must be the deliverable rather than a plan, acknowledgement, or request for input. The agent returns `HEARTBEAT_OK` when nothing needs doing and states failures plainly; cron owns retry and failure-alert policy.

    For trusted scheduled jobs, the job's own instructions win when they intentionally ask for a question or plan, and the agent may remove a job that is no longer needed. External hook turns receive only the common unattended contract; they do not receive that override or self-removal guidance across the external-content boundary.

  </Accordion>
  <Accordion title="Subagent and Discord delivery">
    When isolated cron runs orchestrate subagents, delivery prefers the final descendant output over stale parent interim text. If descendants are still running, OpenClaw suppresses that partial parent update instead of announcing it.

    For text-only Discord announce targets, OpenClaw sends the canonical final assistant text once instead of replaying both streamed/intermediate text and the final answer. Media and structured Discord payloads are still delivered separately so attachments and components are not dropped.

  </Accordion>
</AccordionGroup>

## Delivery and output

| Mode       | What happens                                                        |
| ---------- | ------------------------------------------------------------------- |
| `announce` | Fallback-deliver final text to the target if the agent did not send |
| `webhook`  | POST finished event payload to a URL                                |
| `none`     | No runner fallback delivery                                         |

Use `--announce --channel telegram --to "-1001234567890"` for channel delivery. For Telegram forum topics, use `-1001234567890:topic:123`; OpenClaw also accepts the Telegram-owned `-1001234567890:123` shorthand. Direct RPC/config callers may pass `delivery.threadId` as a string or number. Slack/Discord/Mattermost targets use explicit prefixes (`channel:<id>`, `user:<id>`). Matrix room IDs are case-sensitive; use the exact room ID or `room:!room:server` form from Matrix.

When announce delivery uses `channel: "last"` or omits `channel`, a provider-prefixed target such as `telegram:123` can select the channel before cron falls back to session history or a single configured channel. Only prefixes advertised by the loaded plugin are provider selectors. If `delivery.channel` is explicit, the target prefix must name the same provider; `channel: "whatsapp"` with `to: "telegram:123"` is rejected instead of letting WhatsApp interpret the Telegram ID as a phone number. Target-kind and service prefixes (`channel:<id>`, `user:<id>`, `imessage:<handle>`, `sms:<number>`) stay channel-owned target syntax, not provider selectors.

For isolated jobs, chat delivery is shared: if a chat route is available, the agent can use the `message` tool even with `--no-deliver`. If the agent sends to the configured/current target, OpenClaw skips the fallback announce. Otherwise `announce`, `webhook`, and `none` only control what the runner does with the final reply after the agent turn.

When an agent creates an isolated reminder from an active chat, OpenClaw stores the preserved live delivery target for the fallback announce route. Internal session keys may be lowercase; provider delivery targets are not reconstructed from those keys when current chat context is available.

Implicit announce delivery uses configured channel allowlists to validate and reroute stale targets. DM pairing-store approvals are not fallback automation recipients; set `delivery.to` or configure the channel `allowFrom` entry when a scheduled job should proactively send to a DM.

### Failure notifications

Failure notifications follow a separate destination path:

- `cron.failureDestination` sets a global default for failure notifications.
- `job.delivery.failureDestination` overrides that per job.
- If neither is set and the job already delivers via `announce`, failure notifications fall back to that primary announce target.
- `delivery.failureDestination` is only supported on `sessionTarget="isolated"` jobs unless the primary delivery mode is `webhook`.
- `failureAlert.includeSkipped: true` opts a job or global cron alert policy into repeated skipped-run alerts. Skipped runs keep a separate consecutive-skip counter, so they do not affect execution-error backoff.
- `openclaw cron edit` exposes per-job alert tuning: `--failure-alert`/`--no-failure-alert`, `--failure-alert-after <n>`, `--failure-alert-channel`, `--failure-alert-to`, `--failure-alert-cooldown`, `--failure-alert-include-skipped`/`--failure-alert-exclude-skipped`, `--failure-alert-mode`, and `--failure-alert-account-id`.

### Output language

Cron jobs do not infer a reply language from channel, locale, or previous messages. Put the language rule in the scheduled message or template:

```bash
openclaw cron edit <jobId> \
  --message "Summarize the updates. Respond in Chinese; keep URLs, code, and product names unchanged."
```

For template files, keep the language instruction in the rendered prompt and verify placeholders such as `{{language}}` are filled before the job runs. If the output mixes languages, make the rule explicit, for example: "Use Chinese for narrative text and keep technical terms in English."

## CLI examples

<Tabs>
  <Tab title="One-shot reminder">
    ```bash
    openclaw cron add \
      --name "Calendar check" \
      --at "20m" \
      --session main \
      --system-event "Next heartbeat: check calendar." \
      --wake now
    ```
  </Tab>
  <Tab title="Recurring isolated job">
    ```bash
    openclaw cron create "0 7 * * *" \
      "Summarize overnight updates." \
      --name "Morning brief" \
      --tz "America/Los_Angeles" \
      --session isolated \
      --announce \
      --channel slack \
      --to "channel:C1234567890"
    ```
  </Tab>
  <Tab title="Model and thinking override">
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
  </Tab>
  <Tab title="Webhook output">
    ```bash
    openclaw cron create "0 18 * * 1-5" \
      "Summarize today's deploys as JSON." \
      --name "Deploy digest" \
      --webhook "https://example.invalid/openclaw/cron"
    ```
  </Tab>
  <Tab title="Command output">
    ```bash
    openclaw cron create "*/15 * * * *" \
      --name "Queue depth probe" \
      --command "scripts/check-queue.sh" \
      --command-cwd "/srv/app" \
      --announce \
      --channel telegram \
      --to "-1001234567890"
    ```
  </Tab>
</Tabs>

## Managing jobs

```bash
# List all jobs
openclaw cron list

# Get one stored job as JSON
openclaw cron get <jobId>

# Show one job, including resolved delivery route
openclaw cron show <jobId>

# Enable/disable without deleting
openclaw cron enable <jobId>
openclaw cron disable <jobId>

# Edit a job
openclaw cron edit <jobId> --message "Updated prompt" --model "opus"

# Force run a job now
openclaw cron run <jobId>

# Force run a job now and wait for its terminal status
openclaw cron run <jobId> --wait --wait-timeout 10m --poll-interval 2s

# Run only if due
openclaw cron run <jobId> --due

# View run history
openclaw cron runs --id <jobId> --limit 50

# View one exact run
openclaw cron runs --id <jobId> --run-id <runId>

# Delete a job
openclaw cron remove <jobId>

# Agent selection (multi-agent setups)
openclaw cron create "0 6 * * *" "Check ops queue" --name "Ops sweep" --session isolated --agent ops
openclaw cron edit <jobId> --clear-agent
```

Archiving a session (Control UI, or `sessions.patch { archived: true }` from an operator-admin caller) disables every enabled cron job bound to that session: its isolated `cron:<jobId>` session, a `session:<key>` target, or a delivery/wake `sessionKey` lane. Restoring the session does not re-enable those jobs; use `openclaw cron enable <jobId>`. Sessions with an enabled bound job show a clock badge in the Control UI sidebar.

`openclaw cron run <jobId>` returns after enqueueing the manual run. Use `--wait` for shutdown hooks, maintenance scripts, or other automation that must block until the queued run finishes; it polls the returned `runId` (default timeout `10m`, poll interval `2s`) and exits `0` for status `ok`, non-zero for `error`, `skipped`, or a wait timeout.

The agent `cron` tool returns compact job summaries (`id`, `name`, `enabled`, `nextRunAtMs`, `scheduleKind`, `lastRunStatus`) from `cron(action: "list")`; use `cron(action: "get", jobId: "...")` for one full job definition. Direct Gateway callers can pass `compact: true` to `cron.list`; omitting it preserves the full response with delivery previews.

`openclaw cron create` is an alias for `openclaw cron add`. New jobs can use a positional schedule (`"0 9 * * 1"`, `"every 1h"`, `"20m"`, or an ISO timestamp) followed by a positional agent prompt. Use `--webhook <url>` on `cron add|create` or `cron edit` to POST the finished run payload to an HTTP endpoint; webhook delivery cannot combine with chat delivery flags (`--announce`, `--channel`, `--to`, `--thread-id`, `--account`). On `cron edit`, `--clear-channel`, `--clear-to`, `--clear-thread-id`, and `--clear-account` unset those routing fields individually (each rejected alongside its matching set flag) — distinct from `--no-deliver`, which only disables runner fallback delivery.

<Note>
Model override note:

- `openclaw cron add|edit --model ...` changes the job's selected model.
- If the model is allowed, that exact provider/model reaches the isolated agent run.
- If it is not allowed or cannot be resolved, cron fails the run with an explicit validation error.
- API `cron.update` payload patches can set `model: null` to clear a stored job model override.
- `openclaw cron edit <job-id> --clear-model` clears that override from the CLI (same effect as the `model: null` patch) and cannot combine with `--model`.
- Configured fallback chains still apply because cron `--model` is a job primary, not a session `/model` override.
- `openclaw cron add|edit --fallbacks ...` sets payload `fallbacks`, replacing configured fallbacks for that job; `--fallbacks ""` disables fallback and makes the run strict. `openclaw cron edit <job-id> --clear-fallbacks` clears the per-job override.
- A plain `--model` with no explicit or configured fallback list does not fall through to the agent primary as a silent extra retry target.

</Note>

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

<AccordionGroup>
  <Accordion title="POST /hooks/wake">
    Enqueue a system event for the main session:

    ```bash
    curl -X POST http://127.0.0.1:18789/hooks/wake \
      -H 'Authorization: Bearer SECRET' \
      -H 'Content-Type: application/json' \
      -d '{"text":"New email received","mode":"now"}'
    ```

    <ParamField path="text" type="string" required>
      Event description.
    </ParamField>
    <ParamField path="mode" type="string" default="now">
      `now` or `next-heartbeat`.
    </ParamField>

  </Accordion>
  <Accordion title="POST /hooks/agent">
    Run an isolated agent turn:

    ```bash
    curl -X POST http://127.0.0.1:18789/hooks/agent \
      -H 'Authorization: Bearer SECRET' \
      -H 'Content-Type: application/json' \
      -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.6-sol"}'
    ```

    Fields: `message` (required), `name`, `agentId`, `sessionKey` (requires `hooks.allowRequestSessionKey=true`), `idempotencyKey`, `wakeMode`, `deliver`, `channel`, `to`, `model`, `thinking`, `timeoutSeconds`.

  </Accordion>
  <Accordion title="Mapped hooks (POST /hooks/<name>)">
    Custom hook names resolve via `hooks.mappings` in config. Mappings can transform arbitrary payloads into `wake` or `agent` actions with templates or code transforms.
  </Accordion>
</AccordionGroup>

<Warning>
Keep hook endpoints behind loopback, tailnet, or a trusted reverse proxy.

- Use a dedicated hook token; do not reuse gateway auth tokens.
- Keep `hooks.path` on a dedicated subpath; `/` is rejected.
- Set `hooks.allowedAgentIds` to limit which effective agent a hook can target, including the default agent when `agentId` is omitted.
- Keep `hooks.allowRequestSessionKey=false` unless you require caller-selected sessions.
- If you enable `hooks.allowRequestSessionKey`, also set `hooks.allowedSessionKeyPrefixes` to constrain allowed session key shapes.
- Hook payloads are wrapped with safety boundaries by default.

</Warning>

## Gmail PubSub integration

Wire Gmail inbox triggers to OpenClaw via Google PubSub.

<Note>
**Prerequisites:** `gcloud` CLI, `gog` (gogcli), OpenClaw hooks enabled, Tailscale for the public HTTPS endpoint.
</Note>

### Wizard setup (recommended)

```bash
openclaw webhooks gmail setup --account openclaw@gmail.com
```

This writes `hooks.gmail` config, enables the Gmail preset, and defaults to Tailscale Funnel for the push endpoint (`--tailscale funnel|serve|off`).

<Warning>
The Gmail preset's per-message session separates conversation context; it does not restrict the target agent's tools or workspace. Without a custom mapping that sets `agentId`, Gmail hooks run as the default agent.

For untrusted inboxes, route the hook to a dedicated reader agent, give that agent read-only or no workspace access, and deny filesystem-write, shell, browser, and other unnecessary tools. If it needs to notify the main agent, allow only the required agent-to-agent handoff. See [Prompt injection](/gateway/security#prompt-injection), [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools), and [`tools.agentToAgent`](/gateway/config-tools#toolsagenttoagent).
</Warning>

### Gateway auto-start

When `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts `gog gmail watch serve` on boot and auto-renews the watch. Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to opt out.

### Manual one-time setup

<Steps>
  <Step title="Select the GCP project">
    Select the GCP project that owns the OAuth client used by `gog`:

    ```bash
    gcloud auth login
    gcloud config set project <project-id>
    gcloud services enable gmail.googleapis.com pubsub.googleapis.com
    ```

  </Step>
  <Step title="Create topic and grant Gmail push access">
    ```bash
    gcloud pubsub topics create gog-gmail-watch
    gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
      --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
      --role=roles/pubsub.publisher
    ```
  </Step>
  <Step title="Start the watch">
    ```bash
    gog gmail watch start \
      --account openclaw@gmail.com \
      --label INBOX \
      --topic projects/<project-id>/topics/gog-gmail-watch
    ```
  </Step>
</Steps>

### Gmail model override

```json5
{
  hooks: {
    gmail: {
      model: "openai/gpt-5.6-sol",
      thinking: "high",
    },
  },
}
```

Use the latest-generation, best-tier model available from your provider for untrusted inboxes. The value above is an example; the model must exist in your configured catalog and allowlist.

## Configuration

```json5
{
  cron: {
    enabled: true,
    store: "~/.openclaw/cron/jobs.json",
    triggers: {
      enabled: false,
    },
    webhookToken: "replace-with-dedicated-webhook-token",
    sessionRetention: "24h",
  },
}
```

`webhookToken` is sent as `Authorization: Bearer <token>` on cron webhook POSTs.

`cron.store` is a logical store key and doctor migration path, not a live JSON file to hand-edit. Job data lives in SQLite; use the CLI or Gateway API for changes.

Disable cron: `cron.enabled: false` or `OPENCLAW_SKIP_CRON=1`.

<AccordionGroup>
  <Accordion title="Retry behavior">
    **One-shot retry**: transient errors (rate limit, overload, network, timeout, server error) use a built-in retry schedule. Permanent errors disable the job immediately.

    **Recurring retry**: consecutive execution errors back off on an extended schedule (30s, 60s, 5m, 15m, 60m). Backoff resets after the next successful run.

  </Accordion>
  <Accordion title="Maintenance">
    `cron.sessionRetention` (default `24h`, `false` disables) prunes isolated run-session entries. Run history keeps the newest 2000 terminal rows per job; lost rows retain their 24-hour cleanup window.
  </Accordion>
  <Accordion title="Legacy store migration">
    On upgrade, run `openclaw doctor --fix` to import legacy `~/.openclaw/cron/jobs.json`, `jobs-state.json`, and `runs/*.jsonl` files into SQLite and rename them with a `.migrated` suffix. Malformed job rows are skipped from runtime and copied to `jobs-quarantine.json` for later repair or review.
  </Accordion>
</AccordionGroup>

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

<AccordionGroup>
  <Accordion title="Cron not firing">
    - Check `cron.enabled` and the `OPENCLAW_SKIP_CRON` env var.
    - Confirm the Gateway is running continuously.
    - For `cron` schedules, verify timezone (`--tz`) vs the host timezone.
    - `reason: not-due` in run output means the manual run was checked with `openclaw cron run <jobId> --due` and the job was not due yet.

  </Accordion>
  <Accordion title="Cron fired but no delivery">
    - Delivery mode `none` means no runner fallback send is expected. The agent can still send directly with the `message` tool when a chat route is available.
    - Delivery target missing/invalid (`channel`/`to`) means outbound was skipped.
    - For Matrix, copied or legacy jobs with lowercased `delivery.to` room IDs can fail because Matrix room IDs are case-sensitive. Edit the job to the exact `!room:server` or `room:!room:server` value from Matrix.
    - Channel auth errors (`unauthorized`, `Forbidden`) mean delivery was blocked by credentials.
    - If the isolated run returns only the silent token (`NO_REPLY` / `no_reply`), OpenClaw suppresses direct outbound delivery and the fallback queued-summary path, so nothing is posted back to chat.
    - If the agent should message the user itself, check that the job has a usable route (`channel: "last"` with a previous chat, or an explicit channel/target).

  </Accordion>
  <Accordion title="Cron or heartbeat appears to prevent /new-style rollover">
    - Daily and idle reset freshness is not based on `updatedAt`; see [Session management](/concepts/session#session-lifecycle).
    - Cron wakeups, heartbeat runs, exec notifications, and gateway bookkeeping may update the session row for routing/status, but they do not extend `sessionStartedAt` or `lastInteractionAt`.
    - For legacy rows created before those fields existed, OpenClaw can recover `sessionStartedAt` from the transcript JSONL session header when the file is still available. Legacy idle rows without `lastInteractionAt` use that recovered start time as their idle baseline.

  </Accordion>
  <Accordion title="Timezone gotchas">
    - Cron without `--tz` uses the gateway host timezone.
    - `at` schedules without timezone are treated as UTC.
    - Heartbeat `activeHours` uses configured timezone resolution.

  </Accordion>
</AccordionGroup>

## Related

- [Automation](/automation) — all automation mechanisms at a glance
- [Background Tasks](/automation/tasks) — task ledger for cron executions
- [Heartbeat](/gateway/heartbeat) — periodic main-session turns
- [Timezone](/concepts/timezone) — timezone configuration
