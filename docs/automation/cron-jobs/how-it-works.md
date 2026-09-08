---
doc-schema-version: 1
summary: "Automation runtime model, run lifecycle, and promoting a repeated job into a schedule"
read_when:
  - Deciding whether automations fit a scheduled workload
  - Debugging run lifecycle, catch-up, or task reconciliation
  - Turning a repeated request into a stored schedule
title: "How automations work"
sidebarTitle: "How they work"
---

How the Gateway scheduler runs a job, what it keeps between runs, and how a repeated request becomes a stored schedule. Part of the [Automations](/automation/cron-jobs) guide.

## How automations work

- Automations run **inside the Gateway process**, not inside the model. The Gateway must be running for schedules to fire.
- Job definitions, runtime state, and run history persist in OpenClaw's shared SQLite state database, so restarts do not lose schedules.
- Every automation run creates a [background task](/automation/tasks) record.
- One-shot jobs (`--at`) auto-delete after successful completion: delivery is confirmed, not requested, intentionally suppressed, or explicitly best-effort. Failed or unknown required delivery retains the job disabled for inspection without replaying the payload. Pass `--keep-after-run` to keep successful jobs too.
- Per-run wall-clock budget: `--timeout-seconds` when set. Otherwise, isolated/detached agent-turn jobs are bounded by the scheduler's own 60-minute watchdog before the underlying agent-turn timeout (`agents.defaults.timeoutSeconds`, default 48 hours) would ever apply; command jobs default to 10 minutes, and script payloads default to 5 minutes.
- On Gateway startup, overdue isolated agent-turn jobs are rescheduled instead of replayed immediately, keeping model/tool bootstrap work out of the channel-connect window. Startup catch-up delays survive label or payload-content reconciliation and another restart; changing the schedule starts a new scheduling decision.
- If you drive `openclaw agent` from system cron or another external scheduler, wrap it with a hard-kill escalation even though the CLI already handles `SIGTERM`/`SIGINT`. Gateway-backed runs ask the Gateway to abort accepted runs; `--local` runs get the same abort signal. For GNU `timeout`, prefer `timeout -k 60 600 openclaw agent ...` over plain `timeout 600 ...` — the `-k` value is the backstop if the process cannot drain in time. For systemd units, use a `SIGTERM` stop signal with a grace window (`TimeoutStopSec`) before the final kill. Reusing a `--run-id` while the original Gateway run is still active reports the duplicate as in-flight instead of starting a second run.

<AccordionGroup>
  <Accordion title="Isolated run hardening">
    - Isolated runs best-effort close tracked browser tabs/processes for their `cron:<jobId>` session on completion, and dispose any bundled MCP runtime instances created for the job through the same shared teardown path used by main-session and custom-session runs. Cleanup failures are ignored so the run result still wins.
    - Isolated runs with the narrow automation self-cleanup grant can read scheduler status, a self-filtered list containing only their own job, and that job's run history, and may remove only their own job.
    - Isolated runs guard against stale acknowledgement replies: if the first result is only an interim status update (`on it`, `pulling everything together`, and similar hints) and no descendant subagent is still responsible for the final answer, OpenClaw re-prompts once for the actual result before delivery.
    - Structured execution-denial metadata (including node-host `UNAVAILABLE` wrappers whose nested error starts with `SYSTEM_RUN_DENIED` or `INVALID_REQUEST`) is recognized so a blocked command is not reported as a green run, while ordinary assistant prose is not mistaken for a denial.
    - Run-level agent failures count as job errors even with no reply payload, so model/provider failures increment error counters and trigger failure notifications instead of clearing the job as successful.
    - When a job hits `timeoutSeconds`, the scheduler aborts the run and gives it a short cleanup window. If it does not drain, Gateway-owned cleanup force-clears that run's session ownership before the scheduler records the timeout, so queued chat work is not stuck behind a stale processing session.
    - Setup/startup stalls get a phase-specific timeout (for example `cron: isolated agent setup timed out before runner start` or `cron: isolated agent run stalled before execution start (last phase: context-engine)`). These watchdogs cover embedded and CLI-backed providers even before their external CLI process starts, and are capped independently of long `timeoutSeconds` values so cold-start/auth/context failures surface quickly.

  </Accordion>
  <Accordion title="Task reconciliation">
    Automation task reconciliation is runtime-owned first, durable-history-backed second: an active automation task stays live while the automations runtime still tracks that job as running, even if an old child session row still exists. Once the runtime stops owning the job and a 5-minute grace window expires, maintenance checks persisted run logs and job state for the matching `cron:<jobId>:<startedAt>` run. A terminal result there finalizes the task ledger; otherwise Gateway-owned maintenance can mark the task `lost`. Offline CLI audit can recover from durable history, but its own empty in-process active-job set is not proof a Gateway-owned run is gone.

    Restart recovery matches finalized results to the run identity, never just a coincident start time. A verified live process keeps its run receipt. If a foreign process exists but its start identity cannot be verified, its receipt becomes recoverable after more than two hours from the queued or running start. Recovery revokes that receipt before admitting another run; it cannot undo external side effects already in flight. On Gateway startup, an enabled one-shot interrupted before a terminal task result recovers through normal missed-job catch-up, regardless of how overdue it is. Reclaiming a dead running owner during normal operation records the interruption without replaying the consumed one-shot; a separately rescheduled occurrence remains eligible. Catch-up limits and delays pace recovery; they do not expire it. Pending recovery survives another restart, including during agent-turn deferral. A terminal result is restored without replaying that run, and `deleteAfterRun` deletes the job only when completion is `succeeded`.

  </Accordion>
</AccordionGroup>

## Promoting a repeated job into an automation

Most automations should start as work the agent already did. When you ask for
substantially the same job several times, the agent offers to turn it into a
schedule instead of only running it once more. Promotion is preferred over
building a job from scratch because the proposal inherits a run you already
read: you know what the output looks like before it starts arriving on a
schedule.

There is no repetition-detection engine and no new stored history. The agent
recognizes the repeat from the conversation itself and checks
`automations(action: "list")` for an existing job before proposing a new one,
so a routine you already created is not duplicated. The prompting that drives
this is gated on the automations tool, so agents without it never offer a
routine they could not create.

The confirmation restates the schedule and the task in plain words before
anything is created, for example: "Every weekday at 07:00 Europe/Vienna, I
summarize overnight updates and post them here." Confirm that sentence, not a
cron expression.

On confirmation the agent:

1. Creates the job, with delivery defaulting to the channel and thread where you
   asked.
2. Immediately runs it once with `run` in `force` mode as a visible test,
   delivered to that same thread, so you see real output well before the first
   scheduled occurrence.
3. Removes the job and tells you if that test fails.

The job is created **enabled**, not disabled-pending-approval, and that is a
deliberate safety choice. The scheduler supervises enabled jobs: a failing one
raises a failure notification and is auto-disabled after repeated errors, with
the reason recorded and the owner notified. Nothing supervises a disabled job.
A job left disabled waiting for a confirmation that never arrives is invisible
to every guard, hidden from the default `automations list`, and will never fire
or explain itself — a silent non-outcome, which is a worse failure than a job
that runs and visibly complains.

Your confirmation still gates creation, so nothing is scheduled behind your
back, and the test run is a real run with real delivery rather than a rendered
preview: what you approve is exactly what the schedule will produce.
