---
summary: "Health check steps for provider connectivity"
read_when:
  - Diagnosing web provider health
---
# Health Checks (CLI)

Short guide to verify provider connectivity without guessing.

## Quick checks
- `clawdbot status` — local summary: gateway reachability/mode, update hint, link provider auth age, sessions + recent activity.
- `clawdbot status --all` — full local diagnosis (read-only, color, safe to paste for debugging).
- `clawdbot status --deep` — also probes the running Gateway (per-provider probes when supported).
- `clawdbot health --json` — asks the running Gateway for a full health snapshot (WS-only; no direct Baileys socket).
- Send `/status` as a standalone message in WhatsApp/WebChat to get a status reply without invoking the agent.
- Logs: tail `/tmp/clawdbot/clawdbot-*.log` and filter for `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Deep diagnostics
- Creds on disk: `ls -l ~/.clawdbot/credentials/whatsapp/<accountId>/creds.json` (mtime should be recent).
- Session store: `ls -l ~/.clawdbot/agents/<agentId>/sessions/sessions.json` (path can be overridden in config). Count and recent recipients are surfaced via `status`.
- Relink flow: `clawdbot providers logout && clawdbot providers login --verbose` when status codes 409–515 or `loggedOut` appear in logs. (Note: the QR login flow auto-restarts once for status 515 after pairing.)

## When something fails
- `logged out` or status 409–515 → relink with `clawdbot providers logout` then `clawdbot providers login`.
- Gateway unreachable → start it: `clawdbot gateway --port 18789` (use `--force` if the port is busy).
- No inbound messages → confirm linked phone is online and the sender is allowed (`whatsapp.allowFrom`); for group chats, ensure allowlist + mention rules match (`whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedicated "health" command
`clawdbot health --json` asks the running Gateway for its health snapshot (no direct provider sockets from the CLI). It reports linked creds/auth age when available, per-provider probe summaries, session-store summary, and a probe duration. It exits non-zero if the Gateway is unreachable or the probe fails/timeouts. Use `--timeout <ms>` to override the 10s default.
