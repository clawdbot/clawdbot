---
doc-schema-version: 1
summary: "CLI examples, job management commands, run history, and cron configuration keys"
read_when:
  - Listing, editing, running, or removing a stored job
  - Reading run history and completion status
  - Setting cron configuration keys on the Gateway
title: "Manage automations"
sidebarTitle: "Manage jobs"
---

Day-to-day operation of stored jobs: copy-ready CLI examples, the management commands, run history semantics, and the `cron.*` configuration keys. Part of the [Automations](/automation/cron-jobs) guide.

## CLI examples

<Tabs>
  <Tab title="One-shot reminder">
    ```bash
    openclaw automations add \
      --name "Calendar check" \
      --at "20m" \
      --session main \
      --system-event "Next heartbeat: check calendar." \
      --wake now
    ```
  </Tab>
  <Tab title="Recurring isolated job">
    ```bash
    openclaw automations create "0 7 * * *" \
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
    openclaw automations add \
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
    openclaw automations create "0 18 * * 1-5" \
      "Summarize today's deploys as JSON." \
      --name "Deploy digest" \
      --webhook "https://example.invalid/openclaw/cron"
    ```
  </Tab>
  <Tab title="Command output">
    ```bash
    openclaw automations create "*/15 * * * *" \
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

### Conversational management

In the authenticated Control UI, an administrator with `operator.admin` can ask the agent to list, inspect, update, run, or remove any existing automation on that Gateway, regardless of its creator or channel. For example, ask it to disable a reminder created in Telegram. This matches the administrator's authority on the **Automations** page. Create command payloads through the operator CLI or Gateway API.

The Gateway grants this authority from the authenticated Control UI turn's admission facts. Each operation uses a one-use grant that expires after 60 seconds and remains bound to that exact active run. Channel turns and Control UI turns without `operator.admin` receive no such grant; matching sender IDs, account IDs, or session routes never establish it. If access is denied or a grant expires, retry from a fresh authenticated Control UI administrator turn, or use the **Automations** page.

Each admin management request records its method, run, operational instance, and success or failure in the Gateway's `cron: admin management` log, alongside the ordinary tool audit record. Management authority does not transfer creator attribution or replace the job's scheduled execution policy.

### CLI management

```bash
# List enabled jobs
openclaw automations list

# Include disabled jobs
openclaw automations list --all

# Get one stored job as JSON
openclaw automations get <jobId>

# Show one job, including resolved delivery route
openclaw automations show <jobId>

# Enable/disable without deleting
openclaw automations enable <jobId>
openclaw automations disable <jobId>

# Edit a job
openclaw automations edit <jobId> --message "Updated prompt" --model "opus"

# Force run a job now
openclaw automations run <jobId>

# Force run a job now and wait for its terminal status
openclaw automations run <jobId> --wait --wait-timeout 10m --poll-interval 2s

# Run only if due
openclaw automations run <jobId> --due

# View run history
openclaw automations runs <jobId> --limit 50

# View one exact run
openclaw automations runs <jobId> --run-id <runId>

# Delete a job
openclaw automations remove <jobId>

# Agent selection (multi-agent setups)
openclaw automations create "0 6 * * *" "Check ops queue" --name "Ops sweep" --session isolated --agent ops
openclaw automations edit <jobId> --clear-agent
```

Archiving a session (Control UI, or `sessions.patch { key, archived: true, expectedSessionId }` using the durable ID from `sessions.list`) disables every enabled automation job bound to that session: its isolated `cron:<jobId>` session, a `session:<key>` target, or a delivery/wake `sessionKey` lane. Restoring the session requires the same observed identity and does not re-enable those jobs; use `openclaw automations enable <jobId>`. Sessions with an enabled bound job show a clock badge in the Control UI sidebar.

`openclaw automations run <jobId>` returns after enqueueing the manual run. Use `--wait` for shutdown hooks, maintenance scripts, or other automation that must block until the queued run finishes; it polls the returned `runId` (default timeout `10m`, poll interval `2s`) and exits `0` only for `completionStatus: "succeeded"`. Failed or unknown completion and wait timeouts exit non-zero.

Run-now delivery measures lateness from when the manual request was accepted. An old pending scheduled slot does not make its fresh output stale; automatic and `--due` runs keep the original scheduled time for that check. A manual run still preserves the job's recurring cadence or future one-shot occurrence.

Run history keeps payload execution in `status` (`ok`, `error`, or `skipped`) and whole-run completion in `completionStatus` (`succeeded`, `failed`, or `unknown`). Requested delivery is required unless the admitted job explicitly sets `delivery.bestEffort: true`; delivery-only failure leaves execution `status: "ok"`, does not increment execution error counters or enter retry backoff, and records `completionStatus: "failed"`. An adapter send without a delivery identity stays `unknown`, without an automatic resend that could duplicate the message.

Intentional silence (`NO_REPLY`), intentionally empty output, heartbeat acknowledgments, and channel reply transforms record `deliverySuppressionReason` without claiming delivery or triggering delivery-failure alerts. These successful non-outcomes and successful executions with explicit `delivery.bestEffort: true` delete one-shots normally. A transport hook veto instead records a delivery error without an intentional-suppression reason. Active descendants without a final reply, stale interim output, and output emptied by TTS instead record a delivery error. Retained one-shot jobs do not automatically rerun; inspect their history and delivery outcome before retrying or removing them.

Direct Gateway event sources can use `cron.run` with `mode: "if-enabled"` to run immediately without overriding an operator-disabled or auto-disabled job. Explicit operator run-now commands continue to use `force`.

The agent `automations` tool returns compact job summaries (`id`, `name`, `enabled`, `effectiveAgentId`, `nextRunAt`, `nextRunAtMs`, `scheduleKind`, `lastRunAt`, `lastRunStatus`) from `automations(action: "list")`. `effectiveAgentId` identifies the resolved execution owner, or is `null` when ownership is unresolved. Run dates are exact ISO timestamps, or `null` when absent; the millisecond fields remain available for programmatic callers. Time-based jobs also include their exact `schedule` (`at`, `every`, or `cron`), including disabled jobs with no next run. Event-driven schedules, payloads, and delivery definitions remain omitted; use `automations(action: "get", jobId: "...")` for one full job definition. Direct Gateway callers can pass `compact: true` to `cron.list`; omitting it preserves the full response with delivery previews. `cron.add` includes the same dry-run preview on the created job so create-time output names a resolved route or fail-closed outcome.

`openclaw automations create` is an alias for `openclaw automations add`. New jobs can use a positional schedule (`"0 9 * * 1"`, `"every 1h"`, `"20m"`, or an ISO timestamp) followed by a positional agent prompt. Use `--webhook <url>` on `automations add|create` or `automations edit` to POST the finished run payload to an HTTP endpoint; webhook delivery cannot combine with chat delivery flags (`--announce`, `--channel`, `--to`, `--thread-id`, `--account`). On `automations edit`, `--clear-channel`, `--clear-to`, `--clear-thread-id`, and `--clear-account` unset those routing fields individually (each rejected alongside its matching set flag) — distinct from `--no-deliver`, which only disables runner fallback delivery.

The webhook URL remains subject to the [strict outbound policy](/automation/cron-jobs/delivery#delivery-and-output); configure `cron.webhookSsrfPolicy` for an intentional local or private receiver.

<Note>
Model override note:

- `openclaw automations add|edit --model ...` changes the job's selected model.
- If the model is allowed, that exact provider/model reaches the isolated agent run.
- If it is not allowed or cannot be resolved, the scheduler fails the run with an explicit validation error.
- API `cron.update` payload patches can set `model: null` to clear a stored job model override.
- `openclaw automations edit <job-id> --clear-model` clears that override from the CLI (same effect as the `model: null` patch) and cannot combine with `--model`.
- Configured fallback chains still apply because the automation `--model` is a job primary, not a session `/model` override.
- `openclaw automations add|edit --fallbacks ...` sets payload `fallbacks`, replacing configured fallbacks for that job; `--fallbacks ""` disables fallback and makes the run strict. `openclaw automations edit <job-id> --clear-fallbacks` clears the per-job override.
- A plain `--model` with no explicit or configured fallback list does not fall through to the agent primary as a silent extra retry target.

</Note>

## Configuration

```json5
{
  cron: {
    enabled: true,
    triggers: {
      enabled: false,
    },
    webhookToken: "replace-with-dedicated-webhook-token",
    webhookSsrfPolicy: {
      allowedHostnames: ["127.0.0.1"], // optional exact exception for a trusted receiver
    },
    sessionRetention: "24h",
  },
}
```

`webhookToken` is sent as `Authorization: Bearer <token>` on automation webhook POSTs.
Webhook URLs must not include embedded username/password credentials; use
`webhookToken` when the receiver supports bearer authentication.
`webhookSsrfPolicy` applies to every outbound automation webhook and is strict
when omitted. Prefer narrow `allowedHostnames` entries over the broad
`dangerouslyAllowPrivateNetwork` opt-in.

Automation jobs, run history, and quarantined malformed jobs live in the shared SQLite state database. Use the CLI or Gateway API to change jobs; `cron.store` is retired.

Set `cron.skipMissedJobs: true` to skip recurring (`cron` and `every`) slots missed while the Gateway was offline. At startup, those jobs advance to their next future occurrence instead of catching up, avoiding stale reminders and unnecessary model calls at the cost of dropping missed work. The default is `false` (catch up); one-shot (`at`) jobs retain their normal catch-up behavior either way.

Disable automations: `cron.enabled: false` or `OPENCLAW_SKIP_CRON=1`.

<AccordionGroup>
  <Accordion title="Retry behavior">
    **One-shot retry**: transient errors (rate limit, overload, network, timeout, server error) use a built-in retry schedule. Permanent errors disable the job immediately.

    **Recurring retry**: consecutive execution errors back off on an extended schedule (30s, 60s, 5m, 15m, 60m). Backoff resets after the next successful run.

  </Accordion>
  <Accordion title="Maintenance">
    `cron.sessionRetention` (default `24h`, `false` or `"0h"` disables) prunes isolated run-session entries. Terminal run history is retained for 7 days (`lost` rows for 24 hours), with the newest 2000 rows per job and history class enforced as an additional ceiling.
  </Accordion>
  <Accordion title="Legacy store migration">
    On upgrade, run `openclaw doctor --fix` to import historical `~/.openclaw/cron/jobs.json`, `jobs-state.json`, `jobs-quarantine.json`, and `runs/*.jsonl` files into SQLite and archive the originals with a `.migrated` suffix. Malformed job rows remain recoverable in SQLite while valid jobs keep running.
  </Accordion>
</AccordionGroup>
