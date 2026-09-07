---
summary: "Contain, rotate, audit, and collect evidence after a suspected compromise of your own Gateway"
read_when:
  - You think your Gateway or a channel account was compromised
  - You need to rotate Gateway and provider credentials quickly
  - You are assembling evidence for a security report
title: "Operator incident response"
sidebarTitle: "Incident response"
---

## Incident response

### Contain

1. Stop it: stop the macOS app (if it supervises the Gateway) or terminate your `openclaw gateway` process.
2. Close exposure: set `gateway.bind: "loopback"` (or disable Tailscale Funnel/Serve) until you understand what happened.
3. Freeze access: switch risky DMs/groups to `dmPolicy: "disabled"` / require mentions, and remove any `"*"` allow-all entries.

### Rotate (assume compromise if secrets leaked)

1. Rotate Gateway auth (`gateway.auth.token` / `OPENCLAW_GATEWAY_PASSWORD`) and restart.
2. Rotate remote client secrets (`gateway.remote.token` / `.password`) on any machine that can call the Gateway.
3. Rotate provider/API credentials (WhatsApp creds, Slack/Discord tokens, model/API keys in SQLite auth stores, and encrypted secrets payload values when used).

### Audit

1. Check Gateway logs with `openclaw logs` (or `openclaw --profile <profile> logs` for a named profile). The default path is `/tmp/openclaw/openclaw-YYYY-MM-DD.log`; named profiles use `/tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log`, unless `logging.file` overrides it.
2. Review the relevant transcript(s): `~/.openclaw/agents/<agentId>/sessions/*.jsonl`.
3. Review recent config changes that could have widened access: `gateway.bind`, `gateway.auth`, DM/group policies, `tools.elevated`, plugin changes.
4. Re-run `openclaw security audit --deep` and confirm critical findings are resolved.

### Collect for a report

- Timestamp, gateway host OS + OpenClaw version.
- The session transcript(s) + a short log tail (after redacting).
- What the attacker sent and what the agent did.
- Whether the Gateway was exposed beyond loopback (LAN/Tailscale Funnel/Serve).
