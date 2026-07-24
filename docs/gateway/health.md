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
- These per-channel overrides apply to the built-in channels that expose them today: Discord, Google Chat, iMessage, IRC, Microsoft Teams, Signal, Slack, Telegram, and WhatsApp.

## Uptime monitoring

External uptime monitoring services should use the dedicated `/health` endpoint, not `/v1/chat/completions`.

## Selected readiness criteria

Without a `gateway.readiness` section, `/ready` and `/readyz` use the legacy
Gateway lifecycle and channel checker. Adding the section opts the Gateway into
bounded canonical condition evaluation; an empty section is an explicit opt-in
with no additional selected criteria.

An operator can add registered criteria to the Gateway's lifecycle readiness
conditions without selecting a hosting profile:

```json5
{
  gateway: {
    readiness: {
      requiredCriteria: ["openclaw.workspace-writable", "plugin.storage.backend"],
      advisoryCriteria: ["plugin.metrics.exporter"],
    },
  },
}
```

A plugin criterion is advisory when registered. Listing it in
`requiredCriteria` makes `False`, `Unknown`, timeout, plugin absence, and
registration absence block `/ready` and `/readyz`. Listing it in
`advisoryCriteria` includes failures in diagnostics without blocking readiness.
A criterion cannot appear in both lists.

Core selector IDs are configuration identifiers, not condition types. For
example, selecting `openclaw.workspace-writable` emits the canonical
`WorkspaceWritable` condition; plugin criteria use their namespaced ID as the
condition type.

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
The command reports linked creds/auth age when available, per-channel probe summaries,
session-store summary, and probe duration. It exits non-zero if the gateway is
unreachable or the probe fails/times out.

Options:

- `--json`: machine-readable JSON output
- `--timeout <ms>`: override the default 10s probe timeout
- `--verbose`: force a live probe and print gateway connection details
- `--debug`: alias for `--verbose`

The health snapshot includes: `ok` (boolean), `ts` (timestamp), `durationMs` (probe time), per-channel status, agent availability, and session-store summary.

## Related

- [Gateway runbook](/gateway)
- [Diagnostics export](/gateway/diagnostics)
- [Gateway troubleshooting](/gateway/troubleshooting)
