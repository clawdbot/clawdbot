# OpenClaw Deployment — Improvement Priority

> Synthesized from `DASHBOARD_REPORT.md`, `RANCHBOT_ARCHITECTURE.md`, and DEB gap findings (Daily Executive Briefing analysis from `tools/briefing/daily-executive-briefing.sh` and `reports/daily-briefings/`).
> Scope: **deployment-local homelab stack** (Ranch Bot, DEB, Flask dashboard, `tools/system_manager/`) — not shipped OpenClaw product core.

---

## Priority Framework

Each item is scored on three axes:

| Axis       | Meaning                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| **Impact** | How much operator confidence, data safety, or daily UX improves                        |
| **Risk**   | Chance of breakage, alert spam, data loss, or long-running job harm                    |
| **Effort** | Implementation size: **S** (hours), **M** (1–2 days), **L** (multi-day / cross-system) |

**Priority score** (for ranking): Impact weights highest, then inverse Risk, then inverse Effort.

---

## Master Priority Table

| Rank | ID  | Improvement                                                                | Impact   | Risk | Effort | Source           |
| ---- | --- | -------------------------------------------------------------------------- | -------- | ---- | ------ | ---------------- |
| 1    | P1  | Unify backup discovery across manager, watchdog, DEB, general watchdog     | **High** | Low  | M      | Ranch, DEB       |
| 2    | P2  | Add Telegram chunking to `send-telegram.sh`                                | **High** | Low  | S      | Ranch, DEB       |
| 3    | P3  | Restore safe smart auto-backup when full backup &gt;10 days                | **High** | Med  | M      | Ranch            |
| 4    | P4  | TM JSON freshness guard (warn if `checked_at` &gt;24h)                     | **High** | Low  | S      | Ranch, DEB       |
| 5    | P5  | Restore `openclaw status --deep` in Daily Executive Briefing               | **High** | Low  | S      | DEB              |
| 6    | P6  | Consolidate morning Telegram (watchdogs → state; DEB = digest)             | **Med**  | Low  | S      | Ranch, DEB       |
| 7    | P7  | Fix dashboard page-load performance (lazy/skip model tests)                | **Med**  | Low  | S      | Dashboard        |
| 8    | P8  | Re-enable service health panel (`build_system_health` output)              | **Med**  | Low  | S      | Dashboard        |
| 9    | P9  | `ranch status` freshness (regen if briefing &gt;12h)                       | **Med**  | Low  | S      | Ranch, DEB       |
| 10   | P10 | Diagnose and fix MailManager empty section in DEB                          | **Med**  | Low  | S–M    | DEB              |
| 11   | P11 | Hourly TM pull timer                                                       | **Med**  | Low  | S      | Ranch            |
| 12   | P12 | Watchdog consolidation (`openclaw-watchdog-alerts` → shared backup report) | **Med**  | Low  | M      | Ranch            |
| 13   | P13 | DEB: surface sub-script failures (calendar/mail/TM exit codes)             | **Med**  | Low  | S      | DEB              |
| 14   | P14 | DEB: rename “Listener” → “Voice Listener”; monitor poll timer              | **Low**  | Low  | S      | DEB, Ranch       |
| 15   | P15 | DEB: disk threshold scoring (match dashboard 80/90%)                       | **Low**  | Low  | S      | DEB, Dashboard   |
| 16   | P16 | Gateway Telegram: intercept ranch/backup/tm/briefing routes                | **Med**  | Med  | M      | Ranch            |
| 17   | P17 | CalendarManager via remote Mac (or drop on Linux)                          | **Med**  | Med  | M      | DEB              |
| 18   | P18 | DEB: restore M4 SSH health block (not just Ollama model count)             | **Med**  | Low  | M      | DEB, Dashboard   |
| 19   | P19 | Ship systemd unit templates in repo                                        | **Med**  | Low  | M      | Ranch            |
| 20   | P20 | Manual full backup now (`smart` or `now`) — operational                    | **High** | Med  | S      | Ranch (ops)      |
| 21   | P21 | TM mount remediation on M4 / QNAP                                          | **High** | Med  | M–L    | Ranch (ops)      |
| 22   | P22 | Dashboard: prune `app.py.before-*` snapshot clutter                        | **Low**  | Low  | S      | Dashboard        |
| 23   | P23 | PropertyManager UI in Flask dashboard                                      | **Low**  | Low  | M      | Dashboard        |
| 24   | P24 | DEB + watchdog structured JSON sidecar                                     | **Low**  | Low  | M      | Ranch, DEB       |
| 25   | P25 | Integrate product `openclaw backup create/verify`                          | **Med**  | Med  | L      | Ranch            |
| 26   | P26 | TM auto-remediation hook (mount retry / backupd)                           | **Med**  | Med  | L      | Ranch            |
| 27   | P27 | DEB trends/anomaly section from `reports/trends.csv`                       | **Low**  | Low  | M      | DEB, Dashboard   |
| 28   | P28 | Briefing retention policy (prune test runs)                                | **Low**  | Low  | S      | DEB              |
| 29   | P29 | Dashboard ingest `reports/system_manager/index.json`                       | **Low**  | Low  | M      | Dashboard, Ranch |
| 30   | P30 | Multi-user Telegram / auth hardening                                       | **Low**  | Med  | L      | Ranch            |

---

## Critical Cross-Cutting Issue

**Backup discovery mismatch** (blocks accurate automation):

| Component                     | Discovery pattern                                       | Example latest file                                                                |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `openclaw-backup-manager.sh`  | `/mnt/ai-storage/openclaw-backups/openclaw-*.tar.gz`    | `openclaw-telegram-propertymanager-working-20260610` (6.6G, ~7 days) → **Current** |
| `openclaw-backup-watchdog.sh` | `*openclaw*backup*` OR `*checkpoint*` across many roots | `openclaw-briefing-mailmanager2-backup-*` (Jun 2) → **Critical 14 days**           |
| DEB                           | Same as watchdog                                        | Reports critical while manager would say current                                   |

**P1 must precede P3** — auto-backup on a false “overdue” signal wastes disk; ignoring a true overdue signal because naming differs is worse.

---

## 1. Immediate Actions (This Week)

Operational and low-effort fixes with high impact. No large refactors.

### 1.1 Run a real checkpoint backup (P20) — **today**

```bash
tools/system_manager/openclaw-backup-manager.sh smart
# or: tools/system_manager/openclaw-backup-manager.sh now
```

|            |                                                                                  |
| ---------- | -------------------------------------------------------------------------------- |
| **Impact** | High — clears 14-day stale state for manager-sized archives                      |
| **Risk**   | Medium — long `tar` (~6GB+), disk IO; 199G free on `/mnt/ai-storage` is adequate |
| **Effort** | S (operator action)                                                              |

Verify: new `openclaw-checkpoint-*.tar.gz` in `/mnt/ai-storage/openclaw-backups/`.

### 1.2 Unify backup discovery — design + minimal fix (P1)

|            |                                                                   |
| ---------- | ----------------------------------------------------------------- |
| **Impact** | High — single truth for watchdog, DEB, Ranch Bot, automation      |
| **Risk**   | Low if shared function only changes _selection_, not tar contents |
| **Effort** | M                                                                 |

**Minimum viable:** Extract `tools/system_manager/backup-discovery.sh` with one canonical glob set:

- Search roots: `/mnt/ai-storage/openclaw-backups`, `$HOME/openclaw-backups` (drop whole-repo `$BASE` scan)
- Patterns: `openclaw-*.tar.gz` (matches manager + large working backups) OR explicit allowlist
- Exclude: `*dashboard-backup*`

Wire into watchdog + DEB first; manager already uses narrow find.

### 1.3 Telegram chunking in `send-telegram.sh` (P2)

|            |                                                       |
| ---------- | ----------------------------------------------------- |
| **Impact** | High — DEB at ~3,942 bytes; growth will fail silently |
| **Risk**   | Low                                                   |
| **Effort** | S                                                     |

Split at 3,500 chars with `Part N/M` header (match poll script behavior).

### 1.4 TM freshness guard (P4)

|            |                                              |
| ---------- | -------------------------------------------- |
| **Impact** | High — Jun 17 DEB showed TM data from Jun 12 |
| **Risk**   | Low                                          |
| **Effort** | S                                            |

In `m4-timemachine-report.sh` or DEB: if `checked_at` &gt;24h old, add warning “TM data stale — run pull”.

### 1.5 Restore gateway deep probe in DEB (P5)

|            |                                            |
| ---------- | ------------------------------------------ |
| **Impact** | High — gateway `active` ≠ channels healthy |
| **Risk**   | Low — add 60s timeout                      |
| **Effort** | S                                          |

Re-add `pnpm openclaw status --deep` (removed in executive redesign Jun 13).

### 1.6 Dashboard quick wins (P7, P8)

| Item | Change                                                                | Effort |
| ---- | --------------------------------------------------------------------- | ------ |
| P7   | Skip or button-gate six Ollama `/api/generate` tests on every `GET /` | S      |
| P8   | Render `build_system_health()` grid (already computed, never shown)   | S      |

### 1.7 Consolidate morning Telegram noise (P6)

|            |                                                     |
| ---------- | --------------------------------------------------- |
| **Impact** | Medium — stop 3 alerts before 07:30 for same issues |
| **Risk**   | Low                                                 |
| **Effort** | S                                                   |

**Interim (no code):** Disable Telegram send in backup/TM watchdogs; rely on DEB at 07:30 until watchdogs write state-only.

**Small code change:** Watchdogs set `reports/system_manager/*.txt` only; DEB reads those files instead of re-probing.

### 1.8 Investigate TM / QNAP mount (P21) — operational

|            |                                                                  |
| ---------- | ---------------------------------------------------------------- |
| **Impact** | High — TM `Backup destination unavailable` since at least Jun 12 |
| **Risk**   | Medium — storage infrastructure                                  |
| **Effort** | M (manual on M4 + QNAP)                                          |

Not a script change; blocks accurate DEB TM section.

---

## 2. Near-Term Actions (This Month)

Structural improvements after immediate stabilization.

### 2.1 Safe smart auto-backup restoration (P3)

|            |                                                    |
| ---------- | -------------------------------------------------- |
| **Impact** | High — closes loop from alert → remediation        |
| **Risk**   | Medium — must not run concurrent tars or fill disk |
| **Effort** | M                                                  |

**Recommended design** (merge archived + current watchdog):

```
07:15 openclaw-backup-watchdog.sh
  1. Unified discovery → age
  2. Always write report + state
  3. If overdue:
       a. Once per day max (state: backup-watchdog-last-action.txt)
       b. Telegram ack: "Running smart backup..."
       c. flock /tmp/openclaw-backup.lock
       d. Pre-flight: MIN_FREE_GB on /mnt/ai-storage (e.g. 20G)
       e. openclaw-backup-manager.sh smart   # not blind `now`
       f. Telegram result summary
  4. Else if ok: no Telegram (DEB covers morning status)
```

**Do not** restore archived behavior that Telegrams “all clear” every day.

**Files likely touched:**

- `tools/system_manager/openclaw-backup-watchdog.sh`
- `tools/system_manager/openclaw-backup-manager.sh` (preflight, lock helper)
- `tools/system_manager/backup-discovery.sh` (new, from P1)
- `~/.config/systemd/user/openclaw-backup-watchdog.service` (`TimeoutStartSec=7200`)
- `reports/system_manager/state/backup-watchdog-last-action.txt`

### 2.2 `ranch status` freshness (P9)

Regenerate briefing if latest file mtime &gt;12 hours; else return cached with “as of” timestamp.

**Files:** `tools/property_manager/propertymanager-telegram-command.py`

### 2.3 MailManager + Calendar DEB fixes (P10, P13, P17)

| Item | Approach                                                                           | Effort |
| ---- | ---------------------------------------------------------------------------------- | ------ |
| P10  | Run `mailmanager2-summary.sh` without `2>/dev/null`; log exit code in DEB warnings | S      |
| P13  | Same for calendar; “CalendarManager failed (macOS required)” on Linux              | S      |
| P17  | SSH to M4 for `apple-calendar-summary.sh` or remove empty section                  | M      |

### 2.4 Hourly TM pull timer (P11)

|            |                                                    |
| ---------- | -------------------------------------------------- |
| **Impact** | Medium — fresh JSON for DEB, watchdog, `tm status` |
| **Risk**   | Low                                                |
| **Effort** | S                                                  |

New units: `pull-m4-timemachine-status.service` + `.timer` (`OnCalendar=*:15` hourly).

### 2.5 Watchdog consolidation (P12)

Route `tools/watchdog/openclaw-watchdog-alerts.sh` backup-age logic through unified discovery report.

### 2.6 DEB M4 health regression fix (P18)

Reintroduce SSH-based M4 memory/disk/Ollama process (dashboard already has this pattern); keep LAN Ollama model count as secondary.

### 2.7 Ship systemd templates in repo (P19)

Copy host units to `scripts/systemd/user/` with install docs — backup, TM, briefing, poll timers.

### 2.8 Gateway Telegram ranch routes (P16)

Extend `extensions/telegram/src/bot-message-dispatch.ts` to match ranch/backup/tm/briefing patterns (30s timeout insufficient for backup — use async or defer to poll path).

|          |                                                                      |
| -------- | -------------------------------------------------------------------- |
| **Risk** | Medium — touches product extension; hardcoded deployment paths today |

### 2.9 Dashboard housekeeping (P22)

Archive or delete `tools/dashboard/app.py.before-*` (~100 files); keep last stable + git history.

### 2.10 Briefing retention (P28)

Prune `reports/daily-briefings/` older than 30 days; prefix manual test runs `manual-`.

---

## 3. Long-Term Roadmap

Quarter-scale improvements; depend on near-term foundation (P1, P3, P2).

### Q1 — Reliability platform

| ID  | Goal                                                                             | Depends on                        |
| --- | -------------------------------------------------------------------------------- | --------------------------------- |
| P25 | Align checkpoint tar with `openclaw backup create/verify` manifest               | Product CLI stable on deploy host |
| P24 | JSON sidecars: `reports/system_manager/index.json`, `daily-briefing-latest.json` | P1 unified discovery              |
| P29 | Flask dashboard reads index JSON for watchdog/TM/backup cards                    | P24                               |
| P26 | TM remediation script on M4 (mount retry, `backupd` status)                      | P21 ops baseline                  |

### Q2 — Operator experience

| ID  | Goal                                                            |
| --- | --------------------------------------------------------------- |
| P23 | PropertyManager panel in Flask dashboard (tasks, maintenance)   |
| P27 | DEB day-over-day trends from `reports/trends.csv`               |
| P30 | Multi-chat Telegram auth model                                  |
| P15 | Unified disk threshold policy across DEB + dashboard + watchdog |

### Q3 — Automation maturity

| ID                                                                                  | Goal |
| ----------------------------------------------------------------------------------- | ---- |
| Auto-backup after DEB critical block if watchdog did not run                        |
| DEB pre-flight ack for scheduled runs &gt;10s                                       |
| Optional Prometheus/OTEL from `extensions/diagnostics-*` plugins                    |
| Replace standalone Telegram poll with gateway long-polling when ranch routes merged |

---

## Recommended Execution Order

```mermaid
flowchart LR
  subgraph week1 [This Week]
    P20[Manual smart backup]
    P1[Unify discovery]
    P2[Telegram chunking]
    P4[TM freshness]
    P5[DEB deep status]
    P7P8[Dashboard fixes]
  end

  subgraph month1 [This Month]
    P3[Safe auto-backup]
    P6[Alert consolidation]
    P9[P10|P11[TM pull + mail]
    P19[systemd in repo]
  end

  subgraph later [Long Term]
    P25[Product backup CLI]
    P24[P29[JSON + dashboard]
    P23[PropertyManager UI]
  end

  P20 --> P1
  P1 --> P3
  P2 --> P6
  P1 --> P12
  P4 --> P11
  P3 --> P25
```

---

## Risk Controls (Apply to P3 and All Automation)

| Control                                        | Purpose                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| **Once per day** action cap                    | Prevent backup loop on persistent failure                     |
| **`flock` on backup lock file**                | No concurrent `tar` (poll timer + watchdog + manual)          |
| **MIN_FREE_GB preflight**                      | Abort if `/mnt/ai-storage` below threshold                    |
| **`smart` not `now`**                          | Skip if manager sees current checkpoint                       |
| **Unified discovery first**                    | Avoid backing up on false overdue                             |
| **`TimeoutStartSec=7200`** on watchdog service | Allow large tar to finish                                     |
| **Telegram ack before long jobs**              | Operator knows work started                                   |
| **Result Telegram with exit code**             | Visible failure if tar errors                                 |
| **SHA256 alert dedup**                         | Keep for alert-only path                                      |
| **Rollback: env flag**                         | `OPENCLAW_BACKUP_WATCHDOG_AUTO=0` disables auto-run           |
| **Rollback: archived script**                  | `openclaw-backup-watchdog.sh.before-stale-backup-*` preserved |

---

## Rollback Plan (Automation Changes)

1. **Disable auto-backup:** Set `OPENCLAW_BACKUP_WATCHDOG_AUTO=0` or restore alert-only watchdog body from git.
2. **Disable timer:** `systemctl --user disable --now openclaw-backup-watchdog.timer`.
3. **Restore prior watchdog:** Copy `openclaw-backup-watchdog.sh.before-stale-backup-20260613-082740` → active name (alert-only current version in git).
4. **Verify:** Run watchdog manually; confirm report in `reports/system_manager/openclaw_backup_watchdog_report.txt`.
5. **DEB/Telegram:** Confirm single morning message at 07:30 after P6 consolidation.

---

## Success Metrics

| Metric                                  | Current (Jun 2026)               | Target                        |
| --------------------------------------- | -------------------------------- | ----------------------------- |
| Full backup age (canonical)             | 7–14 days (depends on discovery) | ≤10 days                      |
| Backup watchdog vs manager agreement    | **Disagree**                     | Same latest file + age        |
| DEB Telegram delivery failures          | At risk (&gt;3.9KB)              | 0 failures; chunked           |
| TM `checked_at` in DEB                  | 5 days stale                     | &lt;24 hours                  |
| Morning Telegram messages (07:15–07:30) | Up to 3                          | 1 (DEB digest)                |
| Dashboard home load time                | Slow (6× Ollama generate)        | &lt;5s without optional tests |
| Gateway channel health in DEB           | systemd only                     | `--deep` or health JSON       |

---

## Source Document Summary

| Document                     | Key contributions to this plan                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DASHBOARD_REPORT.md**      | Dead `build_system_health()`, model test perf, no Ranch/TM in dashboard, snapshot clutter, partial backup UI                                             |
| **RANCHBOT_ARCHITECTURE.md** | Discovery mismatch, alert-only watchdog, archived auto-backup, dual Telegram paths, morning timer overlap, 12 automation opportunities                   |
| **DEB analysis**             | Removed `--deep`, M4 regression, empty calendar/mail on Linux, TM stale data, Telegram size limit, `ranch status` cache, scoring vs watchdog duplication |

---

_Report only. No application code modified. Priorities assume homelab deployment on Intel Mini + M4 Mac with existing systemd user timers._
