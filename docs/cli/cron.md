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

<Note>
Isolated `cron add` jobs default to `--announce` delivery. Use `--no-deliver` to keep output internal. `--deliver` remains as a deprecated alias for `--announce`.
</Note>

### Delivery ownership

Isolated cron chat delivery is shared between the agent and the runner:

- The agent can send directly using the `message` tool when a chat route is available.
- `announce` fallback-delivers the final reply only when the agent did not send directly to the resolved target.
- `webhook` posts the finished payload to a URL.
- `none` disables runner fallback delivery.

`--announce` is runner fallback delivery for the final reply. `--no-deliver` disables that fallback but does not remove the agent's `message` tool when a chat route is available.

Reminders created from an active chat preserve the live chat delivery target for fallback announce delivery. Internal session keys may be lowercase; do not use them as a source of truth for case-sensitive provider IDs such as Matrix room IDs.

### Failure delivery

Failure notifications resolve in this order:

1. `delivery.failureDestination` on the job.
2. Global `cron.failureDestination`.
3. The job's primary announce target (when no explicit failure destination is set).

<Note>
Main-session jobs may only use `delivery.failureDestination` when primary delivery mode is `webhook`. Isolated jobs accept it in all modes.
</Note>

Note: isolated cron runs treat run-level agent failures as job errors even when
no reply payload is produced, so model/provider failures still increment error
counters and trigger failure notifications.

## Scheduling

### One-shot jobs

`--at <datetime>` schedules a one-shot run. Offset-less datetimes are treated as UTC unless you also pass `--tz <iana>`, which interprets the wall-clock time in the given timezone.

<Note>
One-shot jobs delete after success by default. Use `--keep-after-run` to preserve them.
</Note>

### Recurring jobs

Recurring jobs use exponential retry backoff after consecutive errors: 30s, 1m, 5m, 15m, 60m. The schedule returns to normal after the next successful run.

Skipped runs are tracked separately from execution errors. They do not affect retry backoff, but `openclaw cron edit <job-id> --failure-alert-include-skipped` can opt failure alerts into repeated skipped-run notifications.

Note: cron job definitions live in `jobs.json`, while pending runtime state lives in `jobs-state.json`. If `jobs.json` is edited externally, the Gateway reloads changed schedules and clears stale pending slots; formatting-only rewrites do not clear the pending slot.

### Manual runs

`openclaw cron run` returns as soon as the manual run is queued. Successful responses include `{ ok: true, enqueued: true, runId }`. Use `openclaw cron runs --id <job-id>` to follow the eventual outcome.

<Note>
`openclaw cron run <job-id>` force-runs by default. Use `--due` to keep the older "only run if due" behavior.
</Note>

## Models

`cron add|edit --model <ref>` selects an allowed model for the job.

<Warning>
If the model is not allowed, cron warns and falls back to the job's agent or default model selection. Configured fallback chains still apply, but a plain model override with no explicit per-job fallback list no longer appends the agent primary as a hidden extra retry target.
</Warning>

### Isolated cron model precedence

Isolated cron resolves the active model in this order:

1. Gmail-hook override.
2. Per-job `--model`.
3. Stored cron-session model override (when the user selected one).
4. Agent or default model selection.

### Fast mode

Isolated cron fast mode follows the resolved live model selection. Model config `params.fastMode` applies by default, but a stored session `fastMode` override still wins over config.

### Live model switch retries

If an isolated run throws `LiveSessionModelSwitchError`, cron persists the switched provider and model (and switched auth profile override when present) for the active run before retrying. The outer retry loop is bounded to two switch retries after the initial attempt, then aborts instead of looping forever.

## Run output and denials

### Stale acknowledgement suppression

Isolated cron turns suppress stale acknowledgement-only replies. If the first result is just an interim status update and no descendant subagent run is responsible for the eventual answer, cron re-prompts once for the real result before delivery.

### Silent token suppression

If an isolated cron run returns only the silent token (`NO_REPLY` or `no_reply`), cron suppresses both direct outbound delivery and the fallback queued summary path, so nothing is posted back to chat.

### Structured denials

Isolated cron runs prefer structured execution-denial metadata from the embedded run, then fall back to known denial markers in final output, such as `SYSTEM_RUN_DENIED`, `INVALID_REQUEST`, and approval-binding refusal phrases.

`cron list` and run history surface the denial reason instead of reporting a blocked command as `ok`.

## Retention

Retention and pruning are controlled in config:

- `cron.sessionRetention` (default `24h`) prunes completed isolated run sessions.
- `cron.runLog.maxBytes` and `cron.runLog.keepLines` prune `~/.openclaw/cron/runs/<jobId>.jsonl`.

## Migrating older jobs

<Note>
If you have cron jobs from before the current delivery and store format, run `openclaw doctor --fix`. Doctor normalizes legacy cron fields (`jobId`, `schedule.cron`, top-level delivery fields including legacy `threadId`, payload `provider` delivery aliases) and migrates simple `notify: true` webhook fallback jobs to explicit webhook delivery when `cron.webhook` is configured.
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

Create an isolated job with lightweight bootstrap context:

```bash
openclaw cron add \
  --name "Lightweight morning brief" \
  --cron "0 7 * * *" \
  --session isolated \
  --message "Summarize overnight updates." \
  --light-context \
  --no-deliver
```

`--light-context` applies to isolated agent-turn jobs only. For cron runs, lightweight mode keeps bootstrap context empty instead of injecting the full workspace bootstrap set.

## Common admin commands

Manual run and inspection:

```bash
openclaw cron list
openclaw cron show <job-id>
openclaw cron run <job-id>
openclaw cron run <job-id> --due
openclaw cron runs --id <job-id> --limit 50
```

`cron runs` entries include delivery diagnostics with the intended cron target, the resolved target, message-tool sends, fallback use, and delivered state.

Agent and session retargeting:

```bash
openclaw cron edit <job-id> --agent ops
openclaw cron edit <job-id> --clear-agent
openclaw cron edit <job-id> --session current
openclaw cron edit <job-id> --session "session:daily-brief"
```

Delivery tweaks:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
openclaw cron edit <job-id> --best-effort-deliver
openclaw cron edit <job-id> --no-best-effort-deliver
openclaw cron edit <job-id> --no-deliver
```

## Related

- [CLI reference](/cli)
- [Scheduled tasks](/automation/cron-jobs)
