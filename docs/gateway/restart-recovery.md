---
summary: "What survives a gateway restart or crash: interrupted agent turns resume automatically, subagents and background tasks recover, queued deliveries drain"
read_when:
  - You want to know whether restarting the gateway loses in-progress agent work
  - An agent run was interrupted by a restart, crash, or config reload
  - You are debugging automatic session recovery after the gateway comes back up
title: "Restart recovery"
---

Conversations, transcripts, scheduled jobs, background task records, and queued
outbound messages live on disk. After a gateway restart, eligible work interrupted
mid-turn is detected and resumed automatically. Recovery is always on and
normally needs no manual intervention. Exhausted infrastructure retries, or a
missing durable message-action authority claim, may quarantine one session
until you inspect or replace it.

This page describes what survives a restart, how interrupted work is detected,
and what the automatic resume looks like.

## What survives a restart

| State                          | Storage                                            | Behavior across restart                                                 |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------- |
| Conversation history           | Per-agent SQLite database                          | Untouched; sessions continue from the stored transcript                 |
| Accepted Control UI follow-ups | Per-agent SQLite pending inputs and browser outbox | Matching interrupted inputs are re-admitted when the browser reconnects |
| Interrupted main-session turn  | Per-agent SQLite session row and transcript        | Automatically resumed or reconciled a few seconds after startup         |
| Subagent runs                  | SQLite (shared state database)                     | Registry restored on boot; interrupted runs resumed                     |
| Background tasks               | SQLite (shared state database)                     | Reconciled on boot; orphaned runs recovered or marked lost              |
| Queued outbound deliveries     | SQLite delivery queue                              | Drained after restart; undelivered replies are retried                  |
| Scheduled (cron) jobs          | SQLite cron store                                  | Schedules persist; the scheduler re-arms on boot                        |
| Restart continuation           | SQLite restart sentinel                            | One-shot follow-up dispatched to the session that asked for the restart |
| Gateway terminal PTYs          | Process memory                                     | End with the old process; terminal sessions are not recovered           |

The Control UI retains accepted text and attachments in its outbox until the
Gateway confirms transcript consumption. After reconnecting, it checks the saved
receipt before resubmitting an interrupted input through normal authentication
and session admission. The old queue and execution authority are never reused.
This preserves each browser outbox's order without submitting already-consumed
messages again. Different browsers can reconnect in a different order.

Accepted Control UI input is committed to its admitted source session before ACP
execution or question consumption. If the conversation routes to a bound ACP
session, the source keeps the original request and the bound session owns the ACP
transcript and reply. An output-persistence failure does not make consumed input
eligible for automatic resubmission.

If the browser no longer has the matching outbox payload, the saved interrupted
input remains available for explicit resend. Cancelled input is not replayed.
Inputs accepted by older versions without resumable custody also require explicit resend.
An uncertain submission stays unconfirmed until its outcome can be reconciled
or the user chooses to retry it. Recovery of a turn already in the transcript
does not depend on the browser returning.

When an update replaces the bundled Control UI, an open tab reloads after the
Gateway reports the new build. Automatic recovery for that reported build and
manual reloads share a bounded document-readiness check, so a transient failed
probe does not immediately strand the tab. Generic lazy-chunk failures make one
automatic probe and leave further recovery to the visible retry action. The
browser still limits automatic navigation to one reload per target build. If the
Gateway remains unavailable, use the visible reload action once it is reachable.

Downgrading to `v2026.9.2` preserves newer accepted-input records, but that version
rejects same-ID retries against retained newer receipts before execution. This
includes queued or interrupted inputs and consumed collected-input receipts;
consumed receipts remain excluded from pending counts. Individually consumed
inputs have already left the pending-input store and retain normal transcript
idempotency. Upgrading again restores matching unconsumed-input recovery through
fresh authentication and admission, provided the session and accepted input have
not been changed or removed. Already-consumed input remains consumed. Do not
delete receipts or change message IDs merely to bypass a downgrade conflict.

Native Codex recovery reconstructs saved document contents under the current
attachment policy and context limits. The Codex plugin owns that native input
path: update its artifact alongside the Gateway. An intentionally pinned older
plugin does not acquire the fix from a core-only update.

Pending delivery rows drain or retry after restart. When a delivery exhausts its
retry budget, recovery reclaims expired producer custody; an active producer
keeps ownership. Failed deliveries cannot send again, but retain the information
needed to settle their owning session or conversation. If that update fails or
the gateway crashes, recovery resumes the update without resending the message.
After settlement, failed rows discard their payload; only reusable or
crash-ambiguous owners keep a minimal bounded or permanent receipt that prevents
duplicate delivery. Delivery uncertainty notices retain their acknowledgment,
so a repeated settlement cannot notify the same intent again.

Finish pending settlements before downgrading. Older builds may discard their
metadata during database repair or drop acknowledged notices while rewriting
session records, even when the schema version is unchanged.
See [Database schemas](/reference/database-schemas) for downgrade precautions.

## Graceful restarts drain first

Startup migration warnings do not prevent the Gateway from starting. It logs the
warnings once and starts degraded; `openclaw status` and `openclaw doctor` show the
running Gateway's warning report. Read-only operators receive the repair hint;
warning details are restricted to administrators and startup logs.
Run `openclaw doctor --fix` against the same
state/config, then restart the Gateway. Unfinished migrations remain pending for
a later startup. Errors that leave required state unsafe to read still stop startup.

A requested restart (`openclaw gateway restart`, a config change that requires
a restart, or a gateway update) does not kill in-flight work immediately. The
gateway stops accepting new work, then waits for active agent turns and
background tasks to finish, up to a drain budget (5 minutes by default). Most
restarts therefore interrupt nothing at all.

Replies to pending node commands remain accepted during the drain, including
worker cleanup started by shutdown. Each reply must still match its live
invocation, node connection, pairing generation, and owning lifecycle. This
lets cleanup finish without waiting for a command timeout; it does not reopen
admission for new requests.

Only work that cannot finish inside the drain budget (or any run interrupted
by a forced restart or a crash) is aborted — and before that happens, each
affected session is marked for recovery.

Restart cancellation also preserves recoverability when the bulk shutdown marker
cannot be written. Native runtime preparation interrupted by the same Gateway
restart is recorded as restart cancellation rather than a provider failure.
Explicit user cancellation and genuine execution timeouts
remain terminal. Recovery startup uses the admitted run's existing deadline,
including runtime preparation and waiting for session or global capacity; waiting
in a healthy queue does not consume separate failed-start attempts.

## Host sleep and process freezes

When a gateway host wakes from sleep, a virtual machine resumes, or the process
continues after a long pause, the gateway detects the freeze within about 30
seconds. It restarts channel connections once tracked Gateway work is idle, then
refreshes cached health and presence. The health and presence refresh still runs
when a busy gateway defers only the channel restart. This keeps stale sockets from
waiting for their normal expiry without interrupting an active reply or agent
startup when a busy event loop caused the timer gap.

The macOS app and Linux companion cooperate with a local gateway by preparing a
short suspension lease before the host sleeps and resuming it after wake. Remote
gateways are not suspended when the app host sleeps. A deliberate suspension
through `gateway.suspend.*` keeps recovery deferred until the controller resumes
the gateway.

## Recovery after a failed update

After a failed interactive update or repair, OpenClaw finishes cleanup and any
service recovery, then opens [`openclaw triage`](/cli/triage). Triage immediately
starts the first directly launchable coding agent in this order: Claude Code,
Codex, OpenCode, then Pi. It passes the captured failure before fresh Doctor
checks or archive collection and asks the agent to diagnose, repair, and verify
the installation. The agent receives the captured installation paths and keeps
its normal authentication, sandbox, and approval settings.

For a failed Control UI or unattended update, use the installation-specific
command printed on the Gateway host, or run triage there with the same OpenClaw
profile and state/config paths. Use `--agent` to select a particular coding agent:

```bash
openclaw triage
openclaw triage --agent codex
```

JSON, `--yes`, and non-interactive update invocations collect diagnostics without
starting an external coding agent. `openclaw triage --non-interactive` also prepares
diagnostics without launching an agent; `--update-result <path>` includes an
updater's saved failure artifact. Printed handoff commands preserve installation
selectors and use PowerShell on Windows or POSIX shells on macOS, Linux, and WSL.

Staging and validation run while the old Gateway serves. The candidate runs
Doctor lint, config and plugin planning, and an isolated canary boot against
copied configuration and verified database snapshots. Migrations on these
copies rehearse the upgrade without changing live state. A validation failure
can enter [bounded unattended repair](/install/updating#unattended-repair-on-your-own-inference)
while the old Gateway keeps serving. Activation requires the failed check to
pass; otherwise the candidate is discarded. An `already-current` no-op never
stops the Gateway.
Older targets that predate migration continuation record runtime validation as
unavailable and use the [existing downgrade finalization path](/install/updating#roll-back-a-package-install).
The detached helper also waits for the `activating` phase before parking its
parent Gateway. The first activation window contains the swap, required live
migrations, and service start. Plugin package download and sync run while the
core Gateway serves. A changed plugin snapshot requires a second measured
activation window: full Doctor migrations under exclusive maintenance, then
restart and verification. Unchanged plugins do not run another full Doctor pass.

After activation, the updater verifies the managed service, the expected
version/build identity, a 12-probe health settle, plugin activation, channels,
and HTTP 200 from `/readyz`. A 15-second inference probe is advisory; provider
unavailability alone records a warning and does not cause rollback. Verification
facts and measured downtime are retained in the [update run report](/cli/update#run-history-and-reports).

When a package fails verification, the updater compares the shared and affected
per-agent SQLite `user_version` values and configuration content with their
pre-activation values. If they are unchanged and the previous runtime was
verified before activation, it restores the previous package, command shim,
service definition, and config writer stamp, then starts that runtime and repeats
the CLI verification checks. Successful recovery leaves that Gateway running
and finishes `rolled-back`, with the failing check kept as the reason and
downtime covering service stop through verified recovery. The writer-stamp guard
does not block this intentional recovery; its allowance is scoped to rollback
service commands and never persisted. See
[Automatic rollback](/install/updating#automatic-schema-neutral-rollback).
If configuration content or a schema version changed, automatic rollback is
refused (`state-migrated-no-rollback`) and the updater attempts bounded repair on
the installed candidate. The same repair slot can run when rollback itself fails.
Code rollback cannot reverse state migrations. An unavailable schema comparison also prevents
automatic rollback (`rollback-state-unverified`). After migration,
a fresh candidate process finishes verification and the same durable run report;
the old updater does not reopen the newer database. Git activation failures before live migrations can restore
the previous source and retained built runtime; later Git failures retain the
candidate for diagnosis.

An update failure does not by itself authorize a candidate restart. Candidate
activation still requires successful validation; a blocking live Doctor result
does not become a restart grant. The previous runtime was verified before the
update, so rollback across unchanged configuration and schemas may restart it
under that prior verification and must verify it again afterward. A detached
helper or Windows task autostart cannot bypass this decision.

During post-activation repair, the orchestrator starts or restarts a stopped or
unhealthy service once after each turn, then reruns verification. Passing checks
allow the run to succeed; if rollback already restored the previous release,
successful repair finishes `rolled-back` and the command still exits nonzero.
Otherwise it fails with the original reason and repair summaries. The agent
cannot issue service lifecycle commands.

On Windows, captured Scheduled Task autostart stays suspended through Doctor
finalization. The updater enables the task for activation and restores
suspension if final verification fails, including after a migrated-state handoff.
Native task-control failures appear in the update report; failed suspension
never triggers automatic re-enablement of the rejected installation.

On macOS, a terminated update helper can leave the selected Gateway LaunchAgent
installed but unloaded and disabled across logins. `openclaw doctor` and
`openclaw doctor --fix` diagnose this state; `--fix` leaves an already-stopped
Gateway stopped. If the update was interrupted or installation safety is
uncertain, rerun `openclaw update` or use Doctor and triage before starting it.
Once verified, run `openclaw gateway start` (or
`openclaw --profile <profile> gateway start`) to re-enable and start that service.
Keep the same state/config and custom-label overrides; Doctor prints the selected
label and recovery command. Interactive Doctor can offer bootstrap repair.

A cancellation before package mutation can restore the original service under
its existing handoff ownership. Recovery succeeds only after the Gateway passes
the normal restart health checks and reports the verified installation version
and, for Git recovery, the exact restored build ID. A matching package version
alone cannot distinguish two Git builds. A service
manager accepting a start request, or reporting a live PID, is insufficient.
Once the detached helper launches the updater, a missing, malformed, oversized,
or interrupted direct result leaves activation to the operator. This is stricter
than older helpers that restarted after an unclassified failure. Installing a new
target does not change an already-running historical helper; these checks apply
to the helper version that started the update.

A skipped update before activation does not park or restart the Gateway. If an
interruption occurs after parking, the helper uses the child's verified recovery
decision and preserves the original reason. A zero exit is retained only if
required recovery succeeds or the child already verified it.

Updater exit code `79` keeps the Gateway parked only when the previous generation
cannot be safely restored and verified. When the updater has restored the previous
generation across unchanged configuration and schemas and supplies a verified
recovery decision, the helper starts and verifies it instead of leaving it
stopped. Helper recovery verifies service liveness, version/build identity,
plugin activation, and channel health. It does not repeat the separate `/readyz`
or inference probes; those report fields remain unverified.
The run then finishes `rolled-back` with the previous version and measured
downtime. Missing recovery proof, migrated state, or failed restoration still
requires repair before restart. A service that is observed stopped is recorded
as stopped; the report does not reuse its pre-activation running status.

A terminal failed update still exits nonzero when later service recovery or
triage repair succeeds. Error and skip notifications are attempted before recovery; the helper
does not recreate them after the recovering Gateway consumes them. Check the
final CLI result and the handoff log for the recovery outcome.

Repair the failed Doctor or installation check before restarting. Triage can
inspect `openclaw gateway status --deep` and the update diagnostics. Avoid blindly installing
older code after a newer release has migrated configuration or databases; see
[Updating and recovery](/install/updating). Restart sentinels report the outcome;
copying one does not grant permission to restart a service.

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
  If a `before_agent_reply` hook is installed, admission records enough phase
  state to distinguish a completed silent result from an ambiguous side-effect
  window. Recovery dispatches an ordinary user-triggered agent turn, so the
  currently loaded `before_agent_reply` hooks run under their normal trigger
  rules. Ambiguous prior hook outcomes resume with restart-safe tools rather
  than replaying unrestricted side effects.
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
failure cannot start the same recovery twice. Completed Control UI turns also
retain bounded durable idempotency tombstones, allowing a reconnecting outbox
to retire them without re-executing the request.

Message-tool-only replies use a second durable correlation. Before a terminal
same-conversation send reaches the channel, the gateway records an unresolved
delivery intent on the exact session and source turn. A confirmed provider
success resolves it to a durable delivered receipt; a confirmed failure clears
it. Recovery completes a delivered receipt without rerunning tools. If a crash
leaves the provider outcome unknown, recovery resumes with restart-safe tools
so the model can inspect and report the ambiguity without replaying the
external effect.

The delivered reply is also mirrored into the transcript with its source
message ID. Terminal mirrors use a distinct receipt key, so a progress send with
the same provider idempotency key cannot mask the terminal marker. Progress
sends and receipts from older turns cannot complete the current turn. Only
durable channel-ingress claims can restore message-action authority. A resumed
run keeps the original source-delivery mode and source correlation, including
requester identity and any same-channel/thread restriction, so the same receipt
remains authoritative even if another restart happens during recovery. A
message-tool-only turn without reconstructable channel authority is tombstoned
because OpenClaw cannot safely mint message-action authority without the
original channel-ingress claim. The terminal notice directs the user to start a
replacement with `/new` or `/reset`.

A recovered Control UI turn can finish [pinned dashboard widgets](/tools/show-widget)
using the interrupted turn's exact session and recovery claim. A browser connection
does not survive the restart: recovery retains dashboard authoring, while inline
and device presentation still require their normal client capabilities.

Before resuming, the gateway classifies the transcript tail to choose the tool
restriction for the continuation. An aborted turn is the interruption itself,
so it resumes on a best-effort basis whatever abort detail the provider or worker recorded with it:
partial streamed text stays in the transcript and the continuation picks up from
the message beneath it, while a tool call left dangling is dropped from the next
provider payload. Provider failures, completed assistant tails, empty transcripts,
and stale pending approvals also continue from the existing transcript. States
with ambiguous side effects normally use restart-safe tools. A session with
effective **Full Access**, including an inherited Full Access default, keeps its
ordinary tools so it can inspect the outcome and finish the task. Recovery does
not replay the interrupted call automatically or treat its missing result as
success. Existing tool restrictions and current permissions still apply.
Pending reply delivery, ambiguous reply-hook outcomes, and explicitly replay-safe
Code Mode reconstruction retain their narrower recovery restrictions.

OpenClaw can also reconstruct interrupted read-only [Code Mode](/tools/code-mode)
work. Code Mode marks these runs as restart-safe and rejects side-effecting
catalog or namespace tool calls before they execute. If a restart lands on
the `wait` control, the new gateway reconstructs the turn from its transcript
and forces the reconstructed execution to remain restart-safe even if the
model omits or clears that flag. The host filters the entire reconstructed
turn to audited read-only core tools and explicitly replay-safe plugin tools,
including when Code Mode is disabled after the restart. Other interrupted
Code Mode work resumes for model reconciliation: Full Access keeps its configured
tool surface unless the current turn has an explicitly replay-safe checkpoint;
other sessions retain the restart-safe restriction. Old process-local runs and
approval handles are not revived.

### Subagents

Subagent runs are persisted in the shared SQLite state database, so the
subagent registry survives the process. On boot the registry is restored and
interrupted subagent sessions are resumed with their original task context.

If a parent yielded while waiting for children, recovery first resumes the
interrupted children. Their saved completion batch follows replacement run IDs,
so the parent receives its follow-up after the batch settles, including when some
children finished before the restart.

A completed child may still owe its requester a final follow-up. If that
follow-up is waiting to retry or is interrupted by restart, the saved
obligation survives and resumes after startup. Restart admission rejection
does not consume an attempt, and cancellation of an admitted attempt does
not exhaust the obligation. Existing delivery retry limits still apply.

Two safety valves apply:

- Runs whose recorded interruption is more than 2 hours old are finalized instead
  of resumed. A long-running task interrupted moments ago remains eligible;
  total task age is not the interruption age.
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
to the originating chat and dispatches any requested one-shot continuation turn
so the agent picks up exactly where it left off, on the same channel and thread.

For updates, the sentinel carries `stats.runId`, linking the detached updater to
its durable `update_runs` record. The new Gateway records its observed running
version, build, and startup facts there. It preserves a terminal outcome already
written by the updater and waits while a managed handoff is still pending.
If the existing restart-verification retry window expires, a still-running row
finishes as failed with `restart-unhealthy`; an already-finalized CLI outcome
stays intact.
The post-restart notice is rendered from that row using the same report as
`openclaw update status`; consuming the sentinel does not remove run history.
Sentinels left by older releases retain their existing delivery route.

Any update run with an existing internal origin session, including Control UI
and webchat, appends its report directly to that session's transcript, even when
the caller supplied only `sessionKey` and no `deliveryContext`. A completed
update with no continuation does not wake the model to deliver the report.

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
- **Reply hooks:** resumed turns run currently loaded `before_agent_reply`
  hooks under the normal user-trigger rules. Automatically delivered replies
  also run the normal `reply_payload_sending` hook before channel delivery,
  with the recovered session, run, account, and conversation context.

## Verify recovery after an update

A healthy Gateway confirms availability, not completion of interrupted work.
Check each previously active session and its child tasks: it should have finished
before shutdown, resumed execution, or reached a visible terminal outcome or
recovery error. Check queued inputs separately for transcript consumption or an
explicit unresolved state.

The main-session recovery log distinguishes execution resumption from the later
`main-session restart recovery terminal` event. A recovered count at startup means
execution resumed; it does not prove that an assistant reply was delivered.
Use the session transcript and recorded delivery outcome to verify completion.

## What is not resumed

- Sessions excluded from main-session recovery because another owner already
  handles them: subagent sessions (subagent recovery), cron sessions (the
  scheduler re-runs on schedule), and ACP-managed sessions (the connected IDE
  or client owns the resume).
- Work that was never admitted: messages arriving during the drain window are
  rejected with an explicit restart error rather than silently queued into a
  dying process.
- Gateway terminal PTYs, including operator- and agent-owned terminals. They
  are process-local and end when the Gateway restarts.
- Standalone embedded turns cannot take over a main session with pending
  restart recovery because they do not share the gateway's lifecycle owner.
  Run the turn through the gateway or reset it there with `/new` or `/reset`.
