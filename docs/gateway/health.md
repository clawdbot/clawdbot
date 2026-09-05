---
summary: "Health check commands and gateway health monitoring"
read_when:
  - Diagnosing channel connectivity or gateway health
  - Understanding health check CLI commands and options
title: "Health checks"
---

Short guide to verify channel connectivity without guessing.

## Quick checks

- `openclaw status` - local summary: gateway reachability/mode, update hint, linked channel auth age, sessions + recent activity.
- `openclaw status --all` - full local diagnosis (read-only, color, safe to paste for debugging).
- `openclaw status --deep` - asks the running gateway for a live probe (`health` with `probe:true`), including per-account channel probes when supported.
- `openclaw status --usage` - show model provider usage/quota snapshots.
- `openclaw health` - asks the running gateway for its health snapshot (WS-only; no direct channel sockets from the CLI).
- `openclaw health --verbose` (alias `--debug`) - forces a live health probe and prints gateway connection details.
- `openclaw health --json` - machine-readable health snapshot output.
- Send `/status` as a standalone chat command in any channel to get a status reply without invoking the agent.
- Logs: run `openclaw logs --follow` (or `openclaw --profile <profile> logs --follow`) and filter for `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

For Discord and other chat providers, session rows are not socket liveness.
`openclaw sessions`, Gateway `sessions.list`, and the agent `sessions_list` tool
read stored conversation state. A provider can reconnect and show healthy channel
status before any new session row is materialized. Use the channel status and
health commands above for live connectivity checks.

Per-agent session counts and recent activity include only that agent's sessions,
even when agents share a SQLite session store. Status counts each physical store
once in its aggregate. The top-level health session summary represents the
default agent, or the first configured agent when there is no default; it is not
a fleet total.

## Deep diagnostics

- Creds on disk: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime should be recent).
- Session store: `ls -l ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. Count and recent recipients are surfaced via `status`.
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` when status codes 409-515 or `loggedOut` appear in logs. The QR login flow auto-restarts once for status 515 after pairing.
- Diagnostics are enabled by default (`diagnostics.enabled: false` disables them). Memory events record RSS/heap byte counts and threshold/growth pressure. Liveness warnings record event-loop delay/utilization, CPU-core ratio, and active/waiting/queued session counts when the process is running but saturated. Oversized-payload events record what was rejected/truncated/chunked plus sizes and limits, never message text, attachment contents, webhook bodies, raw request/response bodies, tokens, cookies, or secret values.
- The same heartbeat drives the bounded stability recorder: `openclaw gateway stability` (or the `diagnostics.stability` Gateway RPC). Fatal Gateway exits, shutdown timeouts, and restart startup failures persist the latest snapshot under `~/.openclaw/logs/stability/`. Inspect the newest bundle with `openclaw gateway stability --bundle latest`.
- For bug reports, run `openclaw gateway diagnostics export` and attach the generated zip: a Markdown summary, the newest stability bundle, sanitized log metadata, sanitized Gateway status/health snapshots, and config shape. Chat text, webhook bodies, tool outputs, credentials, cookies, account/message identifiers, and secret values are omitted or redacted. See [Diagnostics Export](/gateway/diagnostics).

## Health monitor config

- `channels.<provider>.healthMonitor.enabled`: disable health-monitor restarts for a specific channel while leaving global monitoring enabled.
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`: multi-account override that wins over the channel-level setting.
- These per-channel overrides apply to the channels that expose them today: Discord, Google Chat, iMessage, IRC, Microsoft Teams, Signal, Slack, Telegram, and WhatsApp.
- A crashing channel is recovered by its own auto-restart backoff first (`auto-restart attempt N/10` in the logs). The health monitor stays out of the way until that ladder ends with `giving up after 10 restart attempts`, then takes over as the last restart owner.

## Inbound ingress health

Channel connectivity and inbound admission are separate failure domains. A channel can hold a healthy transport connection — sending replies normally — while its durable ingress queue is unavailable, so not a single inbound message is admitted.

- When a channel cannot open its durable ingress queue, its start fails and the gateway records the account as unable to receive. `openclaw channels status` reports `Channel cannot admit inbound events; its durable ingress queue is unavailable. Outbound may still work.`
- Such an account is **unhealthy** regardless of transport state, and readiness reports it as failing. Previously it reported `health: healthy` and the health monitor never touched it.
- Recovery stays automatic. The ingress verdict describes the account's last start attempt and is cleared by the next one, so the ordinary restart path is also how a transient queue-open failure recovers. Those restarts log as `health-monitor: restarting (reason: ingress-unavailable)` instead of the generic `stuck`.
- If the restarts keep repeating, the cause is not transient. Check the logged ingress failure: a plugin denied the `openChannelIngressQueue` capability, for example, needs operator action rather than another restart.
- Channels that never report ingress state are unaffected: absence means "no signal", never "broken". There is no traffic-staleness heuristic, so a genuinely quiet channel is never marked unhealthy for having received nothing.

## HTTP probes

The Gateway exposes three unauthenticated `GET`/`HEAD` probe pairs:

| Endpoints               | Meaning                                                                                                       | Use                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `/health`, `/healthz`   | The HTTP server is live.                                                                                      | Process liveness and restart decisions.                        |
| `/startup`, `/startupz` | Startup work is complete and the Gateway is not draining. Channel health is not consulted.                    | Orchestrator startup and traffic admission.                    |
| `/ready`, `/readyz`     | Startup is complete, the Gateway is not draining, and configured channel accounts pass deep readiness checks. | Operator monitoring that should surface hard channel failures. |

`/startupz` returns `503` with `status: "starting"` while startup sidecars are pending, `503` with `status: "draining"` during drain, and `200` with `status: "started"` otherwise. Use it for Kubernetes, Fly, Render, and similar traffic admission. A broken Telegram or other channel account can make `/readyz` return `503` without taking a healthy Control UI out of service through `/startupz`.

Remote unauthenticated startup responses contain only `ok` and `status`. Local-direct and authenticated callers also receive `version`, `uptimeMs`, and `pendingReason` while startup is pending. Readiness details follow the same local-or-authenticated gate because they can name failing subsystems.

### CPU pressure and event-loop delay

Detailed readiness can include the latest completed `eventLoop` diagnostic
snapshot. The sampler owns observation windows; health reads do not reset a
pending measurement. No snapshot is available until the first window completes. Its
`cpuCoreRatio` measures user and system CPU time across the whole Gateway process,
including worker and native threads, divided by elapsed wall time. The unit is
core equivalents: `1` means one CPU core fully occupied over the interval, and
parallel work can produce values above `1`. It is not a percentage of the host's
total CPU capacity.

Event-loop delay and utilization describe the main thread separately. A `cpu`
degradation reason reports process CPU pressure with delay co-evidence; it does
not identify the thread consuming CPU or prove a main-thread hang. Inspect the
delay measurements alongside CPU pressure. The `eventLoop` diagnostic does not
change the readiness result by itself.

## Uptime monitoring

External uptime monitoring services should use the dedicated `/health` endpoint, not `/v1/chat/completions`.

- **DO use:** `GET /health` - instant response, no session created, no LLM call, returns `{"ok":true,"status":"live"}`
- **DON'T use:** `/v1/chat/completions` for health checks - each request creates a full agent session with skill snapshot, context assembly, and LLM calls

When no `x-openclaw-session-key` header or `user` field is provided, `/v1/chat/completions` generates a new random session for each request. Monitoring services that ping every 15 minutes create ~96 sessions/day, each consuming 4-22KB. Over time this causes session store bloat and can lead to context window overflow.

### Monitoring service setup examples

- **BetterStack:** Set health check URL to `https://<your-gateway-host>:<port>/health`
- **UptimeRobot:** Add a new HTTP monitor with URL `https://<your-gateway-host>:<port>/health`
- **Generic:** Any HTTP GET to `/health` returns 200 with `{"ok":true}` when the gateway is healthy

## When something fails

- `logged out` or status 409-515 -> relink with `openclaw channels logout` then `openclaw channels login`.
- Gateway unreachable -> start it: `openclaw gateway --port 18789` (use `--force` if the port is busy).
- No inbound messages -> confirm linked phone is online and the sender is allowed (`channels.whatsapp.allowFrom`); for group chats, ensure allowlist + mention rules match (`channels.whatsapp.groups`, `agents.entries.*.groupChat.mentionPatterns`).

## Dedicated "health" command

`openclaw health` asks the running gateway for its health snapshot (no direct channel
sockets from the CLI). By default it returns a fresh cached gateway snapshot and the
gateway refreshes that cache in the background; `--verbose` forces a live probe instead.
Snapshots describe loaded and configured channels. Stored credentials alone do not
activate a channel or add it to Gateway health; use channel setup to enable it.
The command reports linked creds/auth age when available, per-channel probe summaries,
session-store summary, and probe duration. Live probes use bounded account concurrency
and a Gateway-owned deadline, so one slow account returns a structured timeout while
completed sibling results remain available. The command exits non-zero if the gateway is
unreachable or the Gateway call itself times out.

### Queue warnings

A successful health RPC reports top-level `ok: true`. That value means the Gateway
produced the snapshot; it does not mean every delivery queue is clear. Check
`deliveryQueues.ingressPressure` for durable inbound lanes that may be blocking later
events. The field is omitted when no pressured lanes are found.

Ingress pressure uses conservative built-in diagnostic thresholds, not authoritative
retry or claim policy for any plugin. A durable lane appears only when an active pending
or claimed row has either reached at least eight attempts and has a recorded delivery
error, or a claimed row has not refreshed its claim for 30 minutes. Ordinary retries
1-7 are absent. Claim-recovery increments without a recorded error are also absent,
while live claims stay absent because their claim timestamp is refreshed. Rows without
a durable lane key are omitted because they cannot prove that later events are blocked;
runtime persists a derived lane after a real derived-lane retry.

Each result is grouped by channel account and reports pressured lane, pending, claimed,
and blocked counts plus the oldest affected receive time. All active rows in a pressured
lane contribute to those counts. The snapshot never includes lane IDs, event IDs,
payloads, claim owners or tokens, recorded errors, or session and target identifiers.

Options:

- `--json`: machine-readable JSON output
- `--timeout <ms>`: override the default 10s Gateway connection timeout; it does not widen the Gateway's internal live-probe deadline
- `--verbose`: force a live probe and print gateway connection details
- `--debug`: alias for `--verbose`

The health snapshot includes: `ok` (boolean), `ts` (timestamp), `durationMs` (probe time), per-channel status, agent availability, session-store summary, and optional delivery-queue warnings.

## Related

- [Gateway runbook](/gateway)
- [Diagnostics export](/gateway/diagnostics)
- [Gateway troubleshooting](/gateway/troubleshooting)
