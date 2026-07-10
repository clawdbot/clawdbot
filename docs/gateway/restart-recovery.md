---
summary: "What survives a gateway restart or crash: interrupted agent turns resume automatically, subagents and background tasks recover, queued deliveries drain"
read_when:
  - You want to know whether restarting the gateway loses in-progress agent work
  - An agent run was interrupted by a restart, crash, or config reload
  - You are debugging automatic session recovery after the gateway comes back up
title: "Restart recovery"
---

Restarting the gateway does not lose agent state. Conversations, transcripts,
scheduled jobs, background task records, and queued outbound messages all live
on disk, and work that was interrupted mid-turn is detected and resumed
automatically after the gateway comes back up. No manual intervention is
required, and there is nothing to configure: recovery is always on.

This page describes what survives a restart, how interrupted work is detected,
and what the automatic resume looks like.

## What survives a restart

| State                         | Storage                                             | Behavior across restart                                                 |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Conversation history          | JSONL transcripts + per-agent session store on disk | Untouched; sessions continue from the stored transcript                 |
| Interrupted main-session turn | Recovery markers in the session store               | Automatically resumed a few seconds after startup                       |
| Subagent runs                 | SQLite (shared state database)                      | Registry restored on boot; interrupted runs resumed                     |
| Background tasks              | SQLite (shared state database)                      | Reconciled on boot; orphaned runs recovered or marked lost              |
| Queued outbound deliveries    | SQLite delivery queue                               | Drained after restart; undelivered replies are retried                  |
| Scheduled (cron) jobs         | SQLite cron store                                   | Schedules persist; the scheduler re-arms on boot                        |
| Restart continuation          | SQLite restart sentinel                             | One-shot follow-up dispatched to the session that asked for the restart |

## Graceful restarts drain first

A requested restart (`openclaw gateway restart`, a config change that requires
a restart, or a gateway update) does not kill in-flight work immediately. The
gateway stops accepting new work, then waits for active agent turns and
background tasks to finish, up to a drain budget (5 minutes by default). Most
restarts therefore interrupt nothing at all.

Only work that cannot finish inside the drain budget (or any run interrupted
by a forced restart or a crash) is aborted — and before that happens, each
affected session is marked for recovery.

## How interrupted work is detected

Two complementary mechanisms mark sessions whose turn did not finish:

- **At shutdown:** during the restart drain, every session with an active run
  is stamped with a recovery marker in the session store before the run is
  aborted.
- **At startup:** the gateway scans session stores for sessions that still
  claim to be running but have no live owner in the new process. This catches
  hard crashes and kills where no shutdown code ran. Stale transcript lock
  files are cleaned up at the same time.

## Automatic resume

A few seconds after startup, the gateway re-dispatches each marked session
with a synthetic system message telling the agent its previous turn was
interrupted by a restart and to continue from the existing transcript. If a
final reply had already been produced but not delivered, its text is included
so the agent can deliver it instead of redoing the work. Recovery retries up
to 3 times with exponential backoff.

Before resuming, the gateway checks that the transcript tail is safe to
continue from. If it is not (for example, the turn ended on a stale pending
approval), the session is not blindly re-run; the agent instead posts a short
notice asking the user to resend the last request.

### Subagents

Subagent runs are persisted in the shared SQLite state database, so the
subagent registry survives the process. On boot the registry is restored and
interrupted subagent sessions are resumed with their original task context.
Two safety valves apply:

- Runs interrupted more than 2 hours ago are finalized instead of resumed, so
  a gateway that was down overnight does not resurrect stale work.
- A session that repeatedly fails to recover is tombstoned as wedged so
  recovery cannot loop forever.

### Background tasks

The [background task registry](/automation/tasks) is SQLite-backed and
reconciled on boot and on a periodic interval: durable outcomes recorded by
finished runs are recovered, and runs whose owning process disappeared are
marked lost after a grace period instead of hanging forever.

### Agent-requested restarts

When the agent itself triggers a restart (applying a config change, updating
the gateway, or an explicit restart request), a restart sentinel is written to
SQLite before the process exits. After boot the gateway posts the outcome back
to the originating chat and dispatches a one-shot continuation turn so the
agent picks up exactly where it left off, on the same channel and thread.

## Safety valves and observability

- **Crash-loop breaker:** 3 unclean boots within 5 minutes trip a breaker that
  suppresses auto-start side services on the next boot, so a crashing gateway
  does not amplify itself. It recovers once the unclean-boot window drains.
- **Metrics:** recovery activity is exported via
  [Prometheus](/gateway/prometheus) as `openclaw_session_recovery_total` and
  `openclaw_session_recovery_age_seconds`.
- **Logs:** recovery decisions are logged under the
  `main-session-restart-recovery` and `subagent-interrupted-resume`
  subsystems.

## What is not resumed

- Sessions excluded from main-session recovery because another owner already
  handles them: subagent sessions (subagent recovery), cron sessions (the
  scheduler re-runs on schedule), and ACP-managed sessions (the connected IDE
  or client owns the resume).
- Sessions whose transcript tail cannot be safely continued; these get the
  resend notice described above instead of a silent re-run.
- Work that was never admitted: messages arriving during the drain window are
  rejected with an explicit restart error rather than silently queued into a
  dying process.
