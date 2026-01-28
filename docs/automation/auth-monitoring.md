---
summary: "Monitor OAuth expiry for model providers"
read_when:
  - Setting up auth expiry monitoring or alerts
  - Automating Claude Code / Codex OAuth refresh checks
---
# Auth monitoring

Moltbot exposes OAuth expiry health via `moltbot models status`. Use that for
automation and alerting; scripts are optional extras for phone workflows.

## Preferred: CLI check (portable)

```bash
moltbot models status --check
```

Exit codes:
- `0`: OK
- `1`: expired or missing credentials
- `2`: expiring soon (within 24h)

This works in cron/systemd and requires no extra scripts.

## Optional scripts (ops / phone workflows)

These live under `scripts/` and are **optional**. They assume SSH access to the
gateway host and are tuned for systemd + Termux.

- `scripts/claude-auth-status.sh` now uses `moltbot models status --json` as the
  source of truth (falling back to direct file reads if the CLI is unavailable),
  so keep `moltbot` on `PATH` for timers.
- `scripts/auth-monitor.sh`: cron/systemd timer target; sends alerts (ntfy or phone).
- `scripts/systemd/moltbot-auth-monitor.{service,timer}`: systemd user timer.
- `scripts/claude-auth-status.sh`: Claude Code + Moltbot auth checker (full/json/simple).
- `scripts/mobile-reauth.sh`: guided re‑auth flow over SSH.
- `scripts/termux-quick-auth.sh`: one‑tap widget status + open auth URL.
- `scripts/termux-auth-widget.sh`: full guided widget flow.
- `scripts/termux-sync-widget.sh`: sync Claude Code creds → Moltbot.

If you don’t need phone automation or systemd timers, skip these scripts.
