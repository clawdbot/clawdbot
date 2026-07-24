---
title: "RanchBot Architecture"
version: "1.0"
status: "Architecture"
owner: "OpenClaw Architecture"
last_reviewed: "2026-07-19"
category: "Architecture"
source_document: "RANCHBOT_ARCHITECTURE.md"
---

# Ranch Bot Architecture

> **Analysis scope:** `tools/system_manager/`, `tools/telegram/`, `reports/system_manager/`
> **Integration context:** Ranch Bot routing, Telegram polling, and briefing generation live in `tools/property_manager/`, `tools/briefing/`, and `extensions/telegram/` — referenced here only at integration boundaries.
> **systemd units:** discovered on the deployment host at `~/.config/systemd/user/` (not shipped in the OpenClaw repo).

**Ranch Bot** is the deployment’s operator-facing Telegram control plane for homelab operations: backups, Time Machine status, daily briefings, and PropertyManager tasks. It is **not** part of shipped OpenClaw core. The scoped directories provide **infrastructure scripts**, **Telegram delivery**, and **persistent watchdog state**.

---

## File Inventory

### `tools/system_manager/` (active)

| File                            | Type | Purpose                                      |
| ------------------------------- | ---- | -------------------------------------------- |
| `openclaw-backup-manager.sh`    | Bash | Create, status, and smart checkpoint backups |
| `openclaw-backup-watchdog.sh`   | Bash | Stale full-backup scan + Telegram alert      |
| `pull-m4-timemachine-status.sh` | Bash | SCP Time Machine JSON from M4 Mac            |
| `m4-timemachine-report.sh`      | Bash | Pull + format human-readable TM status       |
| `m4-timemachine-watchdog.sh`    | Bash | Daily TM health alert via Telegram           |

### `tools/system_manager/` (archived)

| File                                                              | Purpose                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `openclaw-backup-watchdog.sh.before-stale-backup-20260613-082740` | Prior watchdog that **auto-ran** backup when overdue |

### `tools/telegram/` (active)

| File               | Type | Purpose                                     |
| ------------------ | ---- | ------------------------------------------- |
| `send-telegram.sh` | Bash | Outbound `sendMessage` via Telegram Bot API |
| `reboot-status.sh` | Bash | Post-reboot health summary to Telegram      |

### `tools/telegram/` (archived)

| File                                                     | Purpose                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `send-telegram.sh.before-daily-briefing-20260602-135338` | Snapshot before briefing integration (content identical to current sender) |

### `reports/system_manager/` (runtime artifacts)

| Path                                           | Purpose                                       |
| ---------------------------------------------- | --------------------------------------------- |
| `m4_timemachine_status.json`                   | Latest pulled M4 Time Machine probe           |
| `openclaw_backup_watchdog_report.txt`          | Human-readable last backup watchdog run       |
| `state/openclaw-backup-watchdog.state`         | Dedup hash + last backup metadata             |
| `state/m4-timemachine-watchdog-last-alert.txt` | Date (`YYYY-MM-DD`) of last TM Telegram alert |

### Related files outside scope (integration only)

| Path                                                         | Role in Ranch Bot                            |
| ------------------------------------------------------------ | -------------------------------------------- |
| `tools/property_manager/propertymanager-telegram-command.py` | Deterministic command router                 |
| `tools/property_manager/propertymanager-telegram-poll.sh`    | `getUpdates` poll loop + acks                |
| `tools/briefing/daily-executive-briefing.sh`                 | Daily Executive Briefing generator           |
| `~/.openclaw/credentials/telegram.env`                       | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`     |
| `extensions/telegram/src/bot-message-dispatch.ts`            | Partial PropertyManager shortcut via gateway |

### Repo systemd (not Ranch Bot)

`scripts/systemd/openclaw-auth-monitor.{service,timer}` — unrelated auth monitor; **no** Ranch Bot units in the repo.

---

## Execution Flow

### End-to-end Ranch Bot (Telegram command)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ propertymanager-telegram-poll.timer  (every 10s, user systemd)        │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ flock /tmp/propertymanager-telegram-poll.lock
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ propertymanager-telegram-poll.sh                                        │
│   GET api.telegram.org/.../getUpdates?offset=N&timeout=5                │
│   → authorize chat_id                                                   │
│   → send-telegram.sh  "✅ Acknowledged. OpenClaw Ranch Bot..."          │
│   → propertymanager-telegram-command.py "<user text>"                   │
│   → send-telegram.sh  "<result>"  (chunked 3500 chars)                  │
│   → advance offset                                                      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ propertymanager-telegram-command.py  (router)                           │
├─────────────────────────────────────────────────────────────────────────┤
│ backup *     → openclaw-backup-manager.sh {status|now|smart}            │
│ tm status    → m4-timemachine-report.sh                                 │
│ ranch briefing → daily-executive-briefing.sh                            │
│ ranch status → latest reports/daily-briefings/*.txt                     │
│ property *   → propertymanager-summary / update                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Backup manager flow

```
openclaw-backup-manager.sh {status|now|smart}
  │
  ├─ status → find latest openclaw-checkpoint-*.tar.gz in /mnt/ai-storage/openclaw-backups
  │           → report age vs MAX_AGE_DAYS (10)
  │
  ├─ now    → tar -czf repo + ~/.openclaw (exclude node_modules, .git, venvs, dist, caches)
  │           → write *-status.txt sidecar
  │
  └─ smart  → if no backup or age ≥ 10 days → now; else status + "No action required"
```

### Backup watchdog flow (scheduled)

```
openclaw-backup-watchdog.timer  (07:15 daily)
  → openclaw-backup-watchdog.sh
      → find *openclaw*backup*.tar.gz across repo, $HOME, /mnt/ai-storage (exclude dashboard-backup)
      → write openclaw_backup_watchdog_report.txt + state file
      → if age > 10 days AND alert hash changed → send-telegram.sh alert
      → else exit 0 (deduped alerts)
```

### Time Machine flow

```
m4-timemachine-report.sh
  → pull-m4-timemachine-status.sh
      → scp andrewgraves@100.104.100.96:~/.openclaw/status/m4_timemachine_status.json
      → reports/system_manager/m4_timemachine_status.json
  → Python format → stdout (used by Ranch Bot, briefing, watchdog)

m4-timemachine-watchdog.timer  (07:25 daily)
  → m4-timemachine-watchdog.sh
      → run report → /tmp/m4-tm-report.txt
      → if JSON status ≠ "Current" AND not alerted today → send-telegram.sh
```

### Daily Executive Briefing flow (scheduled + on-demand)

```
openclaw-daily-briefing.timer  (07:30 daily)
  OR  ranch briefing  (Telegram)
  → daily-executive-briefing.sh
      → probe gateway, dashboard, docker, HA, redis, postgres, scrypted, M4 Ollama
      → scan backup ages (same patterns as backup watchdog)
      → m4-timemachine-report.sh  (scoped)
      → propertymanager-summary, calendar, mail (external)
      → write reports/daily-briefings/daily-executive-briefing-<stamp>.txt
      → send-telegram.sh "$(cat briefing)"   (scoped)
```

### Outbound Telegram primitive

```
send-telegram.sh "<message>"
  → source ~/.openclaw/credentials/telegram.env
  → curl POST .../bot${TELEGRAM_BOT_TOKEN}/sendMessage
     -d chat_id=${TELEGRAM_CHAT_ID} -d text="${MESSAGE}"
```

---

## systemd Services

Units live on the deployment host at `~/.config/systemd/user/`. All are **user** units (`systemctl --user`).

### Directly scoped (invoke `tools/system_manager/`)

| Unit                               | Type    | ExecStart                                          |
| ---------------------------------- | ------- | -------------------------------------------------- |
| `openclaw-backup-watchdog.service` | oneshot | `tools/system_manager/openclaw-backup-watchdog.sh` |
| `m4-timemachine-watchdog.service`  | oneshot | `tools/system_manager/m4-timemachine-watchdog.sh`  |

### Related (use scoped `send-telegram.sh`)

| Unit                                    | Type    | ExecStart                                                |
| --------------------------------------- | ------- | -------------------------------------------------------- |
| `openclaw-daily-briefing.service`       | oneshot | `tools/briefing/daily-executive-briefing.sh`             |
| `propertymanager-telegram-poll.service` | oneshot | `propertymanager-telegram-poll.sh` (with flock override) |

### Adjacent (not scoped dirs, but part of Ranch ecosystem)

| Unit                         | Type                  | ExecStart                                        | Note                                       |
| ---------------------------- | --------------------- | ------------------------------------------------ | ------------------------------------------ |
| `openclaw-watchdog.service`  | oneshot               | `tools/watchdog/openclaw-watchdog-alerts.sh`     | General alerts; duplicate backup-age logic |
| `openclaw-listener.service`  | simple (long-running) | `tools/voice_lab/bin/openclaw-listener-start.sh` | **Voice listener — not Telegram poll**     |
| `openclaw-gateway.service`   | —                     | Gateway daemon                                   | Briefing monitors its status               |
| `openclaw-dashboard.service` | —                     | Flask dashboard :5051                            | Briefing monitors its status               |

### `propertymanager-telegram-poll.service.d/override.conf`

```ini
ExecStart=/bin/bash -lc '/usr/bin/flock -n /tmp/propertymanager-telegram-poll.lock \
  .../propertymanager-telegram-poll.sh || true'
```

Prevents overlapping poll runs when the 10-second timer fires faster than a long backup command.

---

## systemd Timers

| Timer                                 | Schedule                                  | Triggers                          | Status (Jun 2026 deploy) |
| ------------------------------------- | ----------------------------------------- | --------------------------------- | ------------------------ |
| `propertymanager-telegram-poll.timer` | `OnBootSec=10`, `OnUnitActiveSec=10`      | Telegram poll (Ranch Bot ingress) | **active**               |
| `openclaw-backup-watchdog.timer`      | `OnCalendar=*-*-* 07:15:00`               | Backup stale scan                 | **active**               |
| `m4-timemachine-watchdog.timer`       | `OnCalendar=*-*-* 07:25:00`               | TM health alert                   | **active**               |
| `openclaw-daily-briefing.timer`       | `OnCalendar=*-*-* 07:30:00`               | Daily Executive Briefing          | **active**               |
| `openclaw-watchdog.timer`             | `OnBootSec=5min`, `OnUnitActiveSec=30min` | General watchdog alerts           | **active**               |

Morning sequence: **07:15** backup watchdog → **07:25** TM watchdog → **07:30** briefing (each can Telegram independently).

`Persistent=true` on all timers — missed runs fire after boot.

---

## Dependencies

### External binaries / tools

| Dependency                               | Used by                                       |
| ---------------------------------------- | --------------------------------------------- |
| `bash`                                   | All scripts                                   |
| `curl`                                   | `send-telegram.sh`, briefing probes           |
| `python3`                                | TM report/watchdog JSON parsing, poll handler |
| `scp` / `ssh`                            | `pull-m4-timemachine-status.sh`               |
| `find`, `stat`, `du`, `tar`, `sha256sum` | Backup manager/watchdog                       |
| `flock`                                  | Telegram poll systemd override                |
| `systemctl --user`                       | Briefing service checks                       |
| `docker`                                 | Briefing container checks                     |
| `pnpm openclaw`                          | Briefing deep status, reboot-status           |

### Credentials and network

| Resource                     | Path / endpoint                                                   |
| ---------------------------- | ----------------------------------------------------------------- |
| Telegram bot token + chat ID | `~/.openclaw/credentials/telegram.env`                            |
| M4 SSH key                   | `~/.ssh/id_ed25519_openclaw_m4`                                   |
| M4 Tailscale                 | `100.104.100.96`                                                  |
| M4 TM status source          | `/Users/andrewgraves/.openclaw/status/m4_timemachine_status.json` |
| QNAP (TM destination)        | `192.168.50.82` (from JSON)                                       |
| Ollama (briefing)            | `192.168.50.117:11434`                                            |
| Backup destination           | `/mnt/ai-storage/openclaw-backups/`                               |

### Inter-script dependency graph (scoped)

```
send-telegram.sh  ◄── openclaw-backup-watchdog.sh
                  ◄── m4-timemachine-watchdog.sh
                  ◄── reboot-status.sh
                  ◄── daily-executive-briefing.sh (external)
                  ◄── propertymanager-telegram-poll.sh (external)

pull-m4-timemachine-status.sh  ◄── m4-timemachine-report.sh
m4-timemachine-report.sh       ◄── m4-timemachine-watchdog.sh
                               ◄── propertymanager-telegram-command.py (external)
                               ◄── daily-executive-briefing.sh (external)

openclaw-backup-manager.sh     ◄── propertymanager-telegram-command.py (external)
                               ◄── (prior) openclaw-backup-watchdog.sh.before-stale-backup-*
```

---

## Ranch Bot

### Definition

Ranch Bot is the **branded Telegram operator interface** implemented as a **deterministic shell-out router** (`propertymanager-telegram-command.py`), not the OpenClaw Pi agent.

### Commands → scoped backends

| Phrases                                   | Backend                                           |
| ----------------------------------------- | ------------------------------------------------- |
| `backup status`, `ranch backup status`, … | `openclaw-backup-manager.sh status`               |
| `backup now`, `run backup`, …             | `openclaw-backup-manager.sh now`                  |
| `smart backup`, `check backup`, …         | `openclaw-backup-manager.sh smart`                |
| `tm status`, `time machine status`, …     | `m4-timemachine-report.sh`                        |
| `ranch briefing`, `daily briefing`, …     | `daily-executive-briefing.sh`                     |
| `ranch status`, `system status`           | Latest `reports/daily-briefings/*.txt` (no regen) |

### Safety boundary

Unrecognized `ranch` / `openclaw` messages get a **static fallback** — never the AI agent.

---

## Daily Executive Briefing

Generator: `tools/briefing/daily-executive-briefing.sh` (outside scope).

**Scoped integrations:**

- Delivers via `tools/telegram/send-telegram.sh`
- Embeds `m4-timemachine-report.sh` (first 32 lines) under Time Machine section
- Uses same backup discovery patterns as `openclaw-backup-watchdog.sh`

**Triggers:** `openclaw-daily-briefing.timer` at 07:30, or `ranch briefing` on Telegram.

**`ranch status`** returns cached briefing only — fast path without re-probing infrastructure.

---

## Backup Watchdogs

### Manager (`openclaw-backup-manager.sh`)

- Writes `openclaw-checkpoint-YYYYMMDD-HHMMSS.tar.gz` to `/mnt/ai-storage/openclaw-backups/`
- Archives repo + `~/.openclaw`; excludes heavy rebuildable paths
- `smart` avoids redundant runs when backup is current

### Watchdog (`openclaw-backup-watchdog.sh`)

- Broader search than manager (multiple roots, multiple filename patterns)
- Excludes `*dashboard-backup*`
- **Alert-only** when age &gt; 10 days; SHA256 dedup prevents repeat Telegram spam
- **Live state (Jun 17, 2026):** `critical` — latest backup 14 days old

### Prior behavior (archived script)

`openclaw-backup-watchdog.sh.before-stale-backup-*` auto-ran `openclaw-backup-manager.sh now` with Ranch Bot-style ack messages. Current watchdog only alerts.

### Overlap with `openclaw-watchdog-alerts.sh`

Separate 30-minute watchdog uses different backup path globs (`$HOME/openclaw-backups/openclaw-backup-*.tar.gz`) — can disagree with `system_manager` watchdog findings.

---

## Time Machine Monitoring

### Pipeline

```
M4 Mac writes JSON → scp pull → reports/system_manager/m4_timemachine_status.json
                              → m4-timemachine-report.sh (human text)
                              → m4-timemachine-watchdog.sh (daily alert)
```

### Live JSON (Jun 12, 2026 — may be stale until next pull)

| Field                  | Value                              |
| ---------------------- | ---------------------------------- |
| `status`               | `Backup destination unavailable`   |
| `qnap_ping`            | `up`                               |
| `smb_445`              | `open`                             |
| `time_machine_running` | `false`                            |
| `error`                | mount destination failed (Code 19) |

Watchdog alerted on **2026-06-17** (state file).

---

## Telegram Command Routing

### Path A — Standalone poll (full Ranch Bot) ✅

`propertymanager-telegram-poll.timer` → `propertymanager-telegram-poll.sh` → `send-telegram.sh` + command router.

Handles **all** Ranch routes: backup, TM, briefing, property.

### Path B — OpenClaw gateway Telegram (partial)

`extensions/telegram/src/bot-message-dispatch.ts` intercepts **PropertyManager-shaped** messages only (`property …`, `pm …`, `* done`, help).

Does **not** intercept `ranch briefing`, `backup status`, `tm status` — those hit the AI agent with a generic ack unless Path A already consumed the update.

### Path C — Scheduled / watchdog outbound

Watchdogs and briefing call `send-telegram.sh` directly — no inbound routing.

### `reboot-status.sh`

Manual/startup helper: `openclaw status --deep` + systemd checks → `send-telegram.sh`.

---

## Agent Acknowledgement Messages

| Context                        | Message                                                                                        | When                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Ranch poll (primary)**       | `✅ Acknowledged. OpenClaw Ranch Bot is working on your request.\n\nCommand:\n<text>`          | Immediately before command script (up to 1800s)       |
| **Gateway PropertyManager**    | `✅ Got it — working on it...`                                                                 | Before `execFileSync` to command router (30s timeout) |
| **Gateway all other msgs**     | `✅ Got it — working on it...`                                                                 | Before Pi agent pipeline (not Ranch routing)          |
| **Old backup watchdog**        | `✅ Acknowledged. Running backup now.` + `🔄 OpenClaw Ranch Bot is working on your request...` | Before auto-backup (archived behavior)                |
| **Current backup watchdog**    | _(none)_                                                                                       | Alert text only on critical                           |
| **TM watchdog**                | _(none)_                                                                                       | Full report as alert                                  |
| **Daily briefing (scheduled)** | _(none)_                                                                                       | Entire briefing is the message                        |
| **`ranch briefing` (manual)**  | Poll ack first, then briefing body                                                             | Two messages via poll path                            |

**Chunking:** Poll path splits replies &gt; 3500 chars into `Part N/M`. `send-telegram.sh` itself does not chunk (4096 Telegram limit).

**Design intent** (from `RANCH_HELP_MSG`): ack before long backup/briefing runs to avoid silent hangs.

---

## Current Capabilities

| Capability                                     | Status                                         |
| ---------------------------------------------- | ---------------------------------------------- |
| Telegram outbound delivery                     | ✅ `send-telegram.sh`                          |
| Checkpoint backup create/status/smart          | ✅ `openclaw-backup-manager.sh`                |
| Stale full-backup detection + alert            | ✅ `openclaw-backup-watchdog.sh` + daily timer |
| M4 TM status pull + human report               | ✅ pull + report scripts                       |
| TM degraded-state daily alert                  | ✅ watchdog + timer                            |
| Daily Executive Briefing (scheduled)           | ✅ 07:30 timer → briefing → `send-telegram.sh` |
| Ranch Bot Telegram ingress                     | ✅ 10s poll timer + flock                      |
| On-demand backup/TM/briefing via Telegram      | ✅ command router                              |
| `ranch status` fast cached briefing            | ✅                                             |
| Ranch/openclaw unknown-command safety fallback | ✅                                             |
| Alert dedup (backup hash, TM daily date)       | ✅                                             |
| Post-reboot Telegram status                    | ✅ `reboot-status.sh`                          |
| Persistent state/report artifacts              | ✅ `reports/system_manager/`                   |

---

## Missing Capabilities

| Gap                                     | Detail                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Repo-shipped systemd units**          | Units exist only on host under `~/.config/systemd/user/`                                 |
| **Gateway Telegram Ranch routing**      | `ranch briefing`, `backup *`, `tm status` not intercepted in `bot-message-dispatch.ts`   |
| **Auto-remediation on stale backup**    | Current watchdog alerts only; archived script auto-ran backup                            |
| **`openclaw backup` CLI integration**   | Separate tar scheme; not manifest-based product backup                                   |
| **Unified backup discovery**            | Manager, watchdog, briefing, and `openclaw-watchdog-alerts.sh` use different globs/paths |
| **TM JSON freshness**                   | Cached JSON can age; pull only on report invocation                                      |
| **TM auto-remediation**                 | Alerts only; no QNAP remount/retry script                                                |
| **`send-telegram.sh` chunking**         | Single message; long texts rely on poll-layer chunking                                   |
| **`ranch briefing` ack**                | Scheduled briefing has no ack; manual trigger gets poll ack only                         |
| **Listener ≠ Telegram**                 | `openclaw-listener.service` is voice lab; easy to confuse with poll service              |
| **Health dashboard for watchdog state** | Reports are plain text/JSON files, not UI                                                |
| **Multi-chat / multi-user**             | Single `TELEGRAM_CHAT_ID`; unauthorized chats get warning only                           |
| **Metrics / structured logging**        | No Prometheus/JSONL event stream for watchdog runs                                       |

---

## Opportunities for Automation

1. **Restore smart auto-backup on overdue** — Reconcile current alert-only watchdog with archived `openclaw-backup-manager.sh now` flow; ack + result Telegram pattern already exists in archived script.

2. **Ship systemd units in repo** — Add `scripts/systemd/user/` templates for backup/TM watchdogs, briefing, and poll timer; document `systemctl --user enable --now`.

3. **Unify backup discovery** — Single shared shell function or small Python module for glob paths, exclusions, and age calculation; consumed by manager, watchdog, briefing, and general watchdog.

4. **Extend gateway Telegram intercept** — Add `ranch`, `backup`, `tm`, `briefing` patterns to `bot-message-dispatch.ts` so gateway-only deployments still route deterministically.

5. **TM pull timer** — Hourly `pull-m4-timemachine-status.sh` independent of report/watchdog so JSON stays fresh for briefing and `ranch status`.

6. **TM remediation hook** — Optional SSH script on M4 to retry mount or restart `backupd` before alerting; escalate only if still non-`Current`.

7. **Briefing pre-flight ack** — When `daily-executive-briefing.sh` runs &gt;30s, send `send-telegram.sh` “Generating briefing…” at start (scheduled runs currently silent until complete).

8. **Integrate product `openclaw backup`** — Align checkpoint tar with `openclaw backup create/verify` manifest for restore confidence.

9. **Watchdog consolidation** — Route `openclaw-watchdog-alerts.sh` backup section through `openclaw-backup-watchdog.sh` report to eliminate conflicting ages.

10. **Auto `smart backup` after critical alert** — Optional timer-triggered `openclaw-backup-manager.sh smart` at 07:20 between watchdog alert and briefing.

11. **Structured report index** — Write `reports/system_manager/index.json` with last-run timestamps, statuses, and alert counts for dashboard consumption.

12. **Telegram delivery hardening** — Move chunking into `send-telegram.sh`; handle `message is too long` API errors with automatic split.

---

## Quick Reference

| Task            | Command                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup status   | `tools/system_manager/openclaw-backup-manager.sh status`                                                                                                       |
| Run backup      | `tools/system_manager/openclaw-backup-manager.sh now`                                                                                                          |
| Smart backup    | `tools/system_manager/openclaw-backup-manager.sh smart`                                                                                                        |
| Backup watchdog | `tools/system_manager/openclaw-backup-watchdog.sh`                                                                                                             |
| TM report       | `tools/system_manager/m4-timemachine-report.sh`                                                                                                                |
| Pull TM JSON    | `tools/system_manager/pull-m4-timemachine-status.sh`                                                                                                           |
| TM watchdog     | `tools/system_manager/m4-timemachine-watchdog.sh`                                                                                                              |
| Send Telegram   | `tools/telegram/send-telegram.sh "message"`                                                                                                                    |
| Reboot status   | `tools/telegram/reboot-status.sh`                                                                                                                              |
| Enable timers   | `systemctl --user enable --now openclaw-backup-watchdog.timer m4-timemachine-watchdog.timer openclaw-daily-briefing.timer propertymanager-telegram-poll.timer` |

---

_Generated from `tools/system_manager/`, `tools/telegram/`, `reports/system_manager/`, and live `~/.config/systemd/user/` units on the deployment host. Does not modify application code._
