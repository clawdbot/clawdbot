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
automatically after the gateway comes back up. Recovery is always on and
normally needs no manual intervention. Repeatedly failing recovery is bounded
and may quarantine one session until you inspect or replace it.

This page describes what survives a restart, how interrupted work is detected,
and what the automatic resume looks like.

## What survives a restart

| State                         | Storage                                     | Behavior across restart                                                 |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| Conversation history          | Per-agent SQLite database                   | Untouched; sessions continue from the stored transcript                 |
| Interrupted main-session turn | Per-agent SQLite session row and transcript | Automatically resumed or reconciled a few seconds after startup         |
| Subagent runs                 | SQLite (shared state database)              | Registry restored on boot; interrupted runs resumed                     |
| Background tasks              | SQLite (shared state database)              | Reconciled on boot; orphaned runs recovered or marked lost              |
| Queued outbound deliveries    | SQLite delivery queue                       | Drained after restart; undelivered replies are retried                  |
| Scheduled (cron) jobs         | SQLite cron store                           | Schedules persist; the scheduler re-arms on boot                        |
| Restart continuation          | SQLite restart sentinel                     | One-shot follow-up dispatched to the session that asked for the restart |

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

Three complementary mechanisms mark sessions whose turn did not finish:

- **At turn admission:** for an ordinary text turn on an existing main session,
  the gateway appends the user message, marks the session running, and records
  its recovery delivery claim in one SQLite transaction before model or
  `before_agent_reply` hook execution. Control UI does this before returning the
  `started` acknowledgement; channel dispatch does it when the prepared turn
  adopts the agent run.
  Commands, attachments, per-turn overrides, pending deliveries, prior abort
  hints, plugin-owned sessions, and turns with execution hooks keep their
  specialized admission paths.
  If a `before_agent_reply` hook is installed, admission also records its phase.
  Recovery never replays a hook interrupted mid-call. Once an unhandled hook
  finishes, its checkpoint records that result, but recovery still fails closed
  while that hook remains active: a checkpoint cannot prove that the same
  plugin code and configuration loaded after the restart. A
  `before_agent_reply` hook may declare a host-enforced
  `eligibleTriggers` scope; a hook limited to scheduled `heartbeat` or `cron`
  turns is not active for a recovered user turn and therefore does not block
  it. Unscoped or invalid registrations remain active for this safety check.
  Handled text and silent results are checkpointed separately for deterministic
  settlement.
  Durable recovery claims written by older versions have no source-ownership
  marker, so they receive the same fail-closed hook check during an upgrade.
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
so the agent can deliver it instead of redoing the work.

Startup reconciliation retries transient failures up to three times with
exponential backoff. Separately, each interrupted main-session cycle has a
durable budget of three charged automatic dispatch attempts, retained across
gateway restarts. OpenClaw charges an attempt before dispatch, refunds it when
the gateway explicitly rejects the request before acceptance, and retains the
charge when a post-dispatch result is uncertain to avoid replaying work.
Foreground work that already owns the session keeps automatic recovery out
until that work settles.

After the durable budget is exhausted, the session is tombstoned instead of
looping forever. Inspect the failed session and use `/new` or `/reset` to start a
replacement. `openclaw doctor --fix` can repair a stale aborted flag that
conflicts with a tombstone, but it does not re-enable that recovery cycle.

Every retry reuses one durable dispatch identifier, so an ambiguous connection
failure cannot start the same recovery twice. Completed and unresumable Control
UI turns also retain bounded durable idempotency tombstones, allowing a
reconnecting outbox to retire them without re-executing the request.

Message-tool-only replies use a second durable correlation. Before a terminal
same-conversation send reaches the channel, the gateway records an unresolved
delivery intent on the exact session and source turn. A confirmed provider
success resolves it to a durable delivered receipt; a confirmed failure clears
it. Recovery completes a delivered receipt without rerunning tools. If a crash
leaves the provider outcome unknown, recovery fails closed instead of replaying
an external effect.

The delivered reply is also mirrored into the transcript with its source
message ID. Terminal mirrors use a distinct receipt key, so a progress send with
the same provider idempotency key cannot mask the terminal marker. Progress
sends and receipts from older turns cannot complete the current turn. Only
durable channel-ingress claims can restore message-action authority. A resumed
run keeps the original source-delivery mode and source correlation, including
requester identity and any same-channel/thread restriction, so the same receipt
remains authoritative even if another restart happens during recovery. A
message-tool-only turn without reconstructable channel authority is failed
closed and receives the one-time resend notice.

Before resuming, the gateway checks that the transcript tail is safe to
continue from. An aborted turn is the interruption itself, so it resumes on a
best-effort basis whatever abort detail the provider or worker recorded with it:
partial streamed text stays in the transcript and the continuation picks up from
the message beneath it, while a tool call left dangling is dropped from the next
provider payload and restricted to restart-safe tools unless it is audited
replay-safe. If the tail is genuinely unsafe (for example a provider failure, or
a turn that ended on a stale pending approval), the session is not blindly
re-run; the agent instead posts a short notice asking the user to resend the
last request. For WebChat, that notice is written directly to the session
history so it remains visible after reconnect.

OpenClaw can also reconstruct interrupted read-only [Code Mode](/tools/code-mode)
work. Code Mode marks these runs as restart-safe and rejects side-effecting
catalog or namespace tool calls before they execute. If a restart lands on
the `wait` control, the new gateway reconstructs the turn from its transcript
and forces the reconstructed execution to remain restart-safe even if the
model omits or clears that flag. The host filters the entire reconstructed
turn to audited read-only core tools and explicitly replay-safe plugin tools,
including when Code Mode is disabled after the restart. Side-effecting work
remains guarded by the resend notice rather than risking a duplicate write.

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

The sentinel's typed SQLite columns are authoritative for restart handling;
its `payload_json` value is a replay/debug shadow only. Runtime reads, writes,
and clears SQLite state without a file fallback. During the storage cutover, a
bounded state migration runs at startup and through Doctor to preserve a
validated `restart-sentinel.json` left by the older process after an update.
The migration verifies the typed row and removes the source file before normal
restart handling continues.

## Safety valves and observability

- **Crash-loop breaker:** 3 unclean boots within 5 minutes trip a breaker that
  suppresses auto-start side services on the next boot, so a crashing gateway
  does not amplify itself. A continuously stable safe-mode gateway rechecks the
  breaker after the full unclean-boot window drains and then resumes deferred
  channel auto-start without requiring another gateway restart.

  When the breaker is tripped, the **control plane still starts**, but channel
  plugins (and other auto-started side services) stay down until an operator
  manually overrides the suppression or the full window drains with no unclean
  boots. Recovery preserves channels that an operator manually stopped and any
  separate development-mode suppression. Gateway logs look like:
  `channel autostart suppressed by crash-loop breaker; refusing automatic
start for <channel>… Start a channel manually with: openclaw gateway call
channels.start --params '{"channel":"<id>"}'`

  Operator recovery SOP:

  1. Confirm the gateway process is up (`openclaw gateway status` / LaunchAgent
     or systemd unit still running). A “channel disconnected” symptom often
     means suppressed autostart, not a dead gateway.
  2. Inspect channel state: `openclaw channels status` (add `--probe` when
     useful). Look for stopped / not connected accounts while the gateway
     itself is healthy.
  3. Fix the root cause of the unclean boots (bad config, plugin crash on
     start, missing secrets) before forcing channels back up.
  4. Manually start a channel while suppression is active:

     ```bash
     openclaw gateway call channels.start --params '{"channel":"<id>"}'
     # optional: {"channel":"<id>","accountId":"<account>"}
     ```

     `channels.start` is a **manual** override; it does not disable the
     breaker for other channels.

  5. Or leave the healthy gateway running until the full unclean-boot window
     drains. The same process logs that the restart-loop breaker recovered and
     starts the deferred configured channels.
     If that message does not appear after the window plus one health-monitor
     interval, inspect the gateway logs and run `openclaw doctor` before
     restarting.

  See also [Gateway](/gateway) (safe mode paragraph) for the same control-plane
  vs channel-autostart split.

- **Main-session attempt budget:** three charged automatic dispatch attempts
  per interrupted cycle; exhaustion tombstones that session until it is
  inspected and replaced.
- **Metrics:** recovery activity is exported via
  [Prometheus](/gateway/prometheus) as `openclaw_session_recovery_total` and
  `openclaw_session_recovery_age_seconds`.
- **Logs:** recovery decisions are logged under the
  `main-session-restart-recovery` and `subagent-interrupted-resume`
  subsystems.
- **Reply hooks:** automatically delivered replies from resumed main-session
  turns run the normal `reply_payload_sending` hook before channel delivery,
  with the recovered session, run, account, and conversation context.

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
- Standalone embedded turns cannot take over a main session with pending
  restart recovery because they do not share the gateway's lifecycle owner.
  Run the turn through the gateway or reset it there with `/new` or `/reset`.
