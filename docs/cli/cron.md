---
summary: "CLI reference for `openclaw cron` (schedule and run background jobs)"
read_when:
  - You want scheduled jobs and wakeups
  - You are debugging cron execution and logs
title: "Cron"
---

# `openclaw cron`

Manage cron jobs for the Gateway scheduler.

<Tip>
Run `openclaw cron --help` for the full command surface. See [Cron jobs](/automation/cron-jobs) for the conceptual guide.
</Tip>

<Note>
All cron mutations (`add`/`create`, `update`/`edit`, `remove`, `run`) require `operator.admin`. Command-payload runs execute directly in the Gateway process, not as an agent `tools.exec` tool call; `tools.exec.*` and exec approvals still govern model-visible exec tools.
</Note>

## Create jobs quickly

`openclaw cron create` is an alias for `openclaw cron add`. For new jobs, put the schedule first and the prompt second:

```bash
openclaw cron create "0 7 * * *" \
  "Summarize overnight updates." \
  --name "Morning brief" \
  --agent ops
```

Use `--webhook <url>` when the job should POST the finished payload instead of delivering to a chat target:

```bash
openclaw cron create "0 18 * * 1-5" \
  "Summarize today's deploys as JSON." \
  --name "Deploy digest" \
  --webhook "https://example.invalid/openclaw/cron"
```

Use `--command` for deterministic shell-style jobs that run inside OpenClaw cron without starting an isolated agent/model run:

```bash
openclaw cron create "*/15 * * * *" \
  --name "Queue depth probe" \
  --command "scripts/check-queue.sh" \
  --command-cwd "/srv/app" \
  --announce \
  --channel telegram \
  --to "-1001234567890"
```

`--command <shell>` stores `argv: ["sh", "-lc", <shell>]`. Use `--command-argv '["node","scripts/report.mjs"]'` for exact argv execution. Command jobs capture stdout/stderr, record normal cron history, and route output through the same `announce`, `webhook`, or `none` delivery modes as isolated jobs. A command that prints only `NO_REPLY` is suppressed.

## Sessions

`--session` accepts `main`, `isolated`, `current`, or `session:<id>`.

<AccordionGroup>
  <Accordion title="Session keys">
    - `main` binds to the agent's main session.
    - `isolated` creates a fresh transcript and session id for each run.
    - `current` binds to the active session at creation time.
    - `session:<id>` pins to an explicit persistent session key.

  </Accordion>
  <Accordion title="Isolated session semantics">
    Isolated runs reset ambient conversation context. Channel and group routing, send/queue policy, elevation, origin, and ACP runtime binding are reset for the new run. Safe preferences and explicit user-selected model or auth overrides can carry across runs.
  </Accordion>
</AccordionGroup>

## Delivery

`openclaw cron list` and `openclaw cron show <job-id>` preview the resolved delivery route. For `channel: "last"`, the preview shows whether the route resolved from the main or current session, or will fail closed.

Provider-prefixed targets can disambiguate unresolved announce channels. For example, `to: "telegram:123"` selects Telegram when `delivery.channel` is omitted or `last`. Only prefixes advertised by the loaded plugin are provider selectors. If `delivery.channel` is explicit, the prefix must match that channel; `channel: "whatsapp"` with `to: "telegram:123"` is rejected. Service prefixes such as `imessage:` and `sms:` remain channel-owned target syntax.

<Note>
Isolated `cron add` jobs default to `--announce` delivery. Use `--no-deliver` to keep output internal. `--deliver` remains as a deprecated alias for `--announce`.
</Note>

### Delivery ownership

Isolated cron chat delivery is shared between the agent and the runner:

- The agent can send directly using the `message` tool when a chat route is available.
- `announce` fallback-delivers the final reply only when the agent did not send directly to the resolved target.
- `webhook` posts the finished payload to a URL.
- `none` disables runner fallback delivery.

Use `cron add|create --webhook <url>` or `cron edit <job-id> --webhook <url>` to set webhook delivery. Do not combine `--webhook` with chat delivery flags such as `--announce`, `--no-deliver`, `--channel`, `--to`, `--thread-id`, or `--account`.

`cron edit <job-id>` can unset individual delivery routing fields with `--clear-channel`, `--clear-to`, `--clear-thread-id`, and `--clear-account` (each is rejected when combined with its matching set flag). Unlike `--no-deliver`, which only disables runner fallback delivery, these remove the stored field so the job resolves that part of its route from defaults again.

`--announce` is runner fallback delivery for the final reply. `--no-deliver` disables that fallback but does not remove the agent's `message` tool when a chat route is available.

Reminders created from an active chat preserve the live chat delivery target for fallback announce delivery. Internal session keys may be lowercase; do not use them as a source of truth for case-sensitive provider IDs such as Matrix room IDs.

### Failure delivery

Failure notifications resolve in this order:

1. `delivery.failureDestination` on the job.
2. Global `cron.failureDestination`.
3. The job's primary announce target (when neither of the above resolves to a concrete destination).

<Note>
Main-session jobs may only use `delivery.failureDestination` when primary delivery mode is `webhook`. Isolated jobs accept it in all modes.
</Note>

Isolated cron runs treat run-level agent failures as job errors even when no reply payload is produced, so model/provider failures still increment error counters and trigger failure notifications.

Command cron jobs do not start an isolated agent turn. A zero exit code records `ok`; non-zero exit, signal, timeout, or no-output timeout records `error` and can trigger the same failure notification path.

If an isolated run times out before the first model request, `openclaw cron show` and `openclaw cron runs` include a phase-specific error such as `setup timed out before runner start` or a stall message naming the last-known startup phase (for example `context-engine`). For CLI-backed providers, the pre-model watchdog stays active until the external CLI turn starts, so session lookup, hook, auth, prompt, and CLI setup stalls are reported as pre-model cron failures.

## Scheduling

### One-shot jobs

`--at <datetime>` schedules a one-shot run. Offset-less datetimes are treated as UTC unless you also pass `--tz <iana>`, which interprets the wall-clock time in the given timezone.

<Note>
One-shot jobs delete after success by default. Use `--keep-after-run` to preserve them.
</Note>

### Recurring jobs

Recurring jobs use exponential retry backoff after consecutive errors: 30s, 1m, 5m, 15m, 60m. The schedule returns to normal after the next successful run.

Skipped runs are tracked separately from execution errors. They do not affect retry backoff, but `openclaw cron edit <job-id> --failure-alert-include-skipped` can opt failure alerts into repeated skipped-run notifications.

For isolated jobs that target a local configured model provider (base URL on loopback, a private network, or `.local`), cron runs a lightweight provider preflight before starting the agent turn: `api: "ollama"` providers are probed at `/api/tags`; other local OpenAI-compatible providers (`api: "openai-completions"`, e.g. vLLM, SGLang, LM Studio) are probed at `/models`. If the endpoint is unreachable, the run is recorded as `skipped` and retried on a later schedule; the reachability result is cached per endpoint for 5 minutes so many jobs against the same local server do not hammer it with repeated probes.

Cron jobs, pending runtime state, and run history live in the shared SQLite state database. Legacy `jobs.json`, `<name>-state.json`, and `runs/*.jsonl` files are imported once and renamed with a `.migrated` suffix. After import, edit schedules with `openclaw cron add|edit|remove` instead of editing JSON files.

### Manual runs

`openclaw cron run <job-id>` force-runs by default and returns as soon as the manual run is queued. Successful responses include `{ ok: true, enqueued: true, runId }`. Use the returned `runId` to inspect the later result:

```bash
openclaw cron run <job-id>
openclaw cron runs --id <job-id> --run-id <run-id>
```

Add `--wait` when a script should block until that exact queued run records a terminal status:

```bash
openclaw cron run <job-id> --wait --wait-timeout 10m --poll-interval 2s
```

With `--wait`, the CLI still calls `cron.run` first, then polls `cron.runs` for the returned `runId`. The command exits `0` only when the run finishes with status `ok`. It exits non-zero when the run finishes with `error` or `skipped`, when the Gateway response does not include a `runId`, or when `--wait-timeout` expires (default `10m`, polled every `2s` by default). `--poll-interval` must be greater than zero.

<Note>
Use `--due` when you want the manual command to run only if the job is currently due. If `--due --wait` does not enqueue a run, the command returns the normal non-run response instead of polling.
</Note>

## Models

`cron add|edit --model <ref>` selects an allowed model for the job. `cron add|edit --fallbacks <list>` sets per-job fallback models, for example `--fallbacks openrouter/gpt-4.1-mini,openai/gpt-5`; pass `--fallbacks ""` for a strict run with no fallbacks. `cron edit <job-id> --clear-fallbacks` removes the per-job fallback override. `cron edit <job-id> --clear-model` removes the per-job model override so the job follows normal cron model-selection precedence (a stored cron-session override if present, otherwise the agent/default model); it cannot be combined with `--model`. `cron add|edit --thinking <level>` sets a per-job thinking override; `cron edit <job-id> --clear-thinking` removes it so the job follows normal cron thinking precedence, and it cannot be combined with `--thinking`.

<Warning>
If the model is not allowed or cannot be resolved, cron fails the run with an explicit validation error instead of falling back to the job's agent or default model selection.
</Warning>

Cron `--model` is a **job primary**, not a chat-session `/model` override. That means:

- Configured model fallbacks still apply when the selected job model fails.
- Per-job payload `fallbacks` replaces the configured fallback list when present.
- An empty per-job fallback list (`--fallbacks ""` or `fallbacks: []` in the job payload/API) makes the cron run strict.
- When a job has `--model` but no fallback list is configured, OpenClaw passes an explicit empty fallback override so the agent primary is not appended as a hidden retry target.
- Local-provider preflight checks walk configured fallbacks before marking a cron run `skipped`.

`openclaw doctor` reports jobs that already have `payload.model` set, including provider namespace counts and mismatches against `agents.defaults.model`. Use that check when auth, provider, or billing behavior looks different between live chat and scheduled jobs.

### Isolated cron model precedence

Isolated cron resolves the active model in this order:

1. Gmail-hook override.
2. Per-job `--model`.
3. Stored cron-session model override (when the user selected one).
4. Agent or default model selection.

### Fast mode

Isolated cron fast mode follows the resolved live model selection. Model config `params.fastMode` applies by default, but a stored session `fastMode` override still wins over config. When the resolved mode is `auto`, the cutoff uses the selected model's `params.fastAutoOnSeconds` value, defaulting to 60 seconds.

### Live model switch retries

If an isolated run throws `LiveSessionModelSwitchError`, cron persists the switched provider and model (and switched auth profile override when present) for the active run before retrying. The outer retry loop is bounded to two switch retries after the initial attempt, then aborts instead of looping forever.

## Run output and denials

### Stale acknowledgement suppression

Isolated cron turns suppress stale acknowledgement-only replies. If the first result is just an interim status update and no descendant subagent run is responsible for the eventual answer, cron re-prompts once for the real result before delivery.

### Silent token suppression

If an isolated cron run returns only the silent token (`NO_REPLY` or `no_reply`), cron suppresses both direct outbound delivery and the fallback queued summary path, so nothing is posted back to chat.

### Structured denials

Isolated cron runs use structured execution-denial metadata from the embedded run (fatal exec-tool errors coded `SYSTEM_RUN_DENIED` or `INVALID_REQUEST`) as the authoritative denial signal. They also honor node-host `UNAVAILABLE` wrappers around a nested structured error carrying one of those codes.

Cron does not classify final-output prose or approval-looking refusal phrases as denials unless the embedded run also provides structured denial metadata, so ordinary assistant text is not treated as a blocked command.

`cron list` and run history surface the denial reason instead of reporting a blocked command as `ok`.

## Retention

Retention behavior:

- `cron.sessionRetention` (default `24h`, or `false` to disable) prunes completed isolated run sessions.
- Run history keeps the newest 2000 terminal rows per cron job. Lost rows retain the standard 24-hour lost-task cleanup window.

## Migrating older jobs

<Note>
If you have cron jobs from before the current delivery and store format, run `openclaw doctor --fix`. Doctor normalizes legacy cron fields (`jobId`, `schedule.cron`, top-level delivery fields including legacy `threadId`, payload `provider` delivery aliases) and migrates `notify: true` webhook fallback jobs from the retired raw `cron.webhook` value to explicit webhook delivery before removing that config key. Jobs that already announce to a chat keep that delivery and get a completion webhook destination. Without a legacy webhook, the inert top-level `notify` marker is removed for jobs with no migration target (the existing delivery is preserved unchanged), so `doctor --fix` no longer keeps re-warning about them.
</Note>

## Common edits

Update delivery settings without changing the message:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Disable delivery for an isolated job:

```bash
openclaw cron edit <job-id> --no-deliver
```

Enable lightweight bootstrap context for an isolated job:

```bash
openclaw cron edit <job-id> --light-context
```

Announce to a specific channel:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

Announce to a Telegram forum topic:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "-1001234567890" --thread-id 42
```

Create an isolated job with lightweight bootstrap context:

```bash
openclaw cron create "0 7 * * *" \
  "Summarize overnight updates." \
  --name "Lightweight morning brief" \
  --session isolated \
  --light-context \
  --no-deliver
```

`--light-context` applies to isolated agent-turn jobs only. For cron runs, lightweight mode keeps bootstrap context empty instead of injecting the full workspace bootstrap set.

Create a command job with exact argv, cwd, env, stdin, and output limits:

```bash
openclaw cron create "*/30 * * * *" \
  --name "Position export" \
  --command-argv '["node","scripts/export-position.mjs"]' \
  --command-cwd "/srv/app" \
  --command-env "NODE_ENV=production" \
  --command-input '{"mode":"summary"}' \
  --timeout-seconds 120 \
  --no-output-timeout-seconds 30 \
  --output-max-bytes 65536 \
  --webhook "https://example.invalid/openclaw/cron"
```

## Common admin commands

Manual run and inspection:

```bash
openclaw cron list
openclaw cron list --agent ops
openclaw cron get <job-id>
openclaw cron show <job-id>
openclaw cron run <job-id>
openclaw cron run <job-id> --due
openclaw cron run <job-id> --wait --wait-timeout 10m
openclaw cron run <job-id> --wait --wait-timeout 10m --poll-interval 2s
openclaw cron runs --id <job-id> --limit 50
openclaw cron runs --id <job-id> --run-id <run-id>
```

`openclaw cron list` shows enabled jobs by default. Pass `--all` to include disabled jobs, or `--agent <id>` to show only jobs whose effective normalized agent id matches; jobs without a stored agent id count as the configured default agent.

`openclaw cron get <job-id>` returns the stored job JSON directly. Use `cron show <job-id>` when you want the human-readable view with delivery-route preview.

`cron list --json` and `cron show <job-id> --json` include a top-level `status` field on each job, computed from `enabled`, `state.runningAtMs`, and `state.lastRunStatus`. Values: `disabled`, `running`, `ok`, `error`, `skipped`, or `idle`. JSON status stays canonical and undecorated so external tooling can read job state without re-deriving it; human output may decorate repeated `error` statuses with a failure count.

`cron runs` entries include delivery diagnostics with the intended cron target, the resolved target, message-tool sends, fallback use, and delivered state.

Agent and session retargeting:

```bash
openclaw cron edit <job-id> --agent ops
openclaw cron edit <job-id> --clear-agent
openclaw cron edit <job-id> --session current
openclaw cron edit <job-id> --session "session:daily-brief"
```

`openclaw cron add` warns when `--agent` is omitted on agent-turn jobs and falls back to the default agent (`main`). Pass `--agent <id>` at create time to pin a specific agent.

Delivery tweaks:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
openclaw cron edit <job-id> --webhook "https://example.invalid/openclaw/cron"
openclaw cron edit <job-id> --best-effort-deliver
openclaw cron edit <job-id> --no-best-effort-deliver
openclaw cron edit <job-id> --no-deliver
```

## Related

- [CLI reference](/cli)
- [Scheduled tasks](/automation/cron-jobs)
