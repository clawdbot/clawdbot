---
title: "OpenClaw Dashboard Report"
version: "1.1"
status: "Architecture"
owner: "OpenClaw Architecture"
last_reviewed: "2026-07-26"
category: "Dashboard"
source_document: "DASHBOARD_REPORT.md"
---

# Dashboard Folder Analysis (`tools/dashboard/`)

Scope: **only** `tools/dashboard/`. This is **not** the shipped OpenClaw Control UI in `ui/`; it is a **deployment-local Flask homelab dashboard** for monitoring AI infrastructure and related services.

---

## Summary

| Item                     | In `tools/dashboard/`?                         |
| ------------------------ | ---------------------------------------------- |
| Custom Flask dashboard   | Yes — `app.py`                                 |
| Ranch Bot                | **No**                                         |
| PropertyManager UI       | **No** (backed up alongside, not integrated)   |
| Time Machine monitoring  | **No**                                         |
| Telegram polling         | **No**                                         |
| Daily Executive Briefing | **No**                                         |
| Backup automation        | **Partial** — manual backup UI + backup script |

---

## 1. Folder Structure

**Active source (excluding backups/venv):**

| Path                                 | Role                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `app.py`                             | Main Flask application (~1,167 lines)                       |
| `dashboard_property_backup.sh`       | Snapshots `app.py` + `tools/property_manager/`              |
| `events.jsonl`                       | JSONL log of service/backup actions (May 2026)              |
| `.venv/`                             | Local Python venv (Flask, matplotlib, requests)             |
| `backups/`                           | Timestamped copies of `app.py` and property_manager bundles |
| `app.py.before-*`, `app.py.backup-*` | ~100+ iterative edit snapshots                              |

There are **no** separate HTML templates, CSS files, or JS modules. The UI is **inline HTML** built in Python.

---

## 2. Runtime Architecture

```
Browser → Flask (0.0.0.0:5051)
            ├── GET  /              → Single-page dashboard
            ├── POST /backup        → Create tar.gz backup
            └── GET  /graphs/<file> → Serve matplotlib PNGs
```

**Stack:** Python 3, Flask, matplotlib (Agg backend), requests, subprocess/shell probes.

**External data sources:**

| Source           | Path / Endpoint                                        |
| ---------------- | ------------------------------------------------------ |
| Trend samples    | `~/ai/projects/openclaw/reports/trends.csv`            |
| AI summary drift | `~/ai/projects/openclaw/reports/home_ai_summary_*.txt` |
| Chart output     | `~/ai/projects/openclaw/reports/graphs/`               |
| Ollama (local)   | `http://127.0.0.1:11434`                               |
| M4 Mac (remote)  | SSH via Tailscale `100.104.100.96`                     |
| Trend collection | `tools/home_manager/collect_trends.sh`                 |

---

## 3. Current Dashboard Panels (live `app.py`)

### System Connectivity Check

- Reads latest `home_ai_summary_*.txt` for warning lines (failed, error, connection refused, notify poll failed).
- Classifies into **Gateway Communication Warning** or **Ollama Connectivity Warning**.
- Shows green “all connected” when no warnings.

### Intel Mini → M4 Model Server

- Probes `http://127.0.0.1:11434/api/tags`.
- Lists model count, primary model (`gpt-oss:20b` preferred), detected model names.

### M4 AI Server Health

- SSH to M4 (`andrewgraves@100.104.100.96`) with `~/.ssh/id_ed25519_openclaw_m4`.
- Remote Python collects: memory (vm_stat), Ollama process/CPU, uptime.
- Local Ollama API status and response time.

### Model Status

- Live inference test for 6 models via `/api/generate`:
  - `llama3.2:3b`, `hermes3:8b`, `gemma3:12b`, `nomic-embed-text:latest`, `gpt-oss:20b`, `glm-4.7-flash:latest`
- 30s timeout per model; runs **on every page load** (can be slow).

### Trend Charts

- Button: **Collect Fresh Sample + Refresh Charts** → runs `collect_trends.sh`.
- Charts from last 24 `trends.csv` rows:
  - Intel Mini Ollama latency
  - Intel + M4 memory usage
  - M4 CPU, disk, Ollama response time
- Dark-theme matplotlib PNGs served from `/graphs/`.

### Storage Health

- Live `df` for `/` and `/mnt/ai-storage`.
- Thresholds: Healthy &lt;80%, Warning 80–90%, Critical &gt;90%.
- Disk usage over time chart from `trends.csv`.

### Manual Backup

- **Backup Now** → POST `/backup`.
- Shows latest verified backup from `~/openclaw-dashboard-backups/`.

### Live Resource Monitor

- CPU (`top`), RAM (`free`), disk (`df`), Docker container count.

---

## 4. Service Health (defined but not rendered)

`build_system_health()` checks:

- OpenClaw Gateway (`openclaw-gateway.service`)
- OpenClaw Listener (`openclaw-listener.service`)
- Docker, Redis, PostgreSQL, Home Assistant, Scrypted
- Ollama API (`curl` to `:11434/api/tags`)

**Note:** `services = build_system_health()` is called in `home()` but the result is **never rendered**. Service status UI was likely removed; only drift warnings remain in the connectivity panel.

---

## 5. Backup Automation

### In-dashboard (`POST /backup`)

Creates `~/openclaw-dashboard-backups/openclaw-dashboard-backup-<timestamp>.tar.gz` containing:

- `tools/dashboard/app.py`
- `~/.config/systemd/user/openclaw-dashboard.service` (if present)

Does **not** back up the full OpenClaw repo or `openclaw backup` state.

### Property backup script (`dashboard_property_backup.sh`)

Copies to `tools/dashboard/backups/propertymanager_app_backups/backup-<stamp>/`:

- `tools/dashboard/app.py`
- `tools/property_manager/` (entire directory)

### Events log (`events.jsonl`)

Records backup OK/ERROR, gateway/voice/docker restart attempts (May 2026).

---

## 6. PropertyManager — Not in Current Dashboard

`dashboard_property_backup.sh` bundles PropertyManager, but **current `app.py` has no PropertyManager routes or UI**.

Backed-up `property_manager/propertymanager-summary.py` (sibling under `tools/`) is a **standalone script** that:

- Reads `property_tasks.csv` and `maintenance_log.csv`
- Computes due tasks and overdue maintenance
- Writes reports to `reports/property_manager/`

**No integration** with the live Flask dashboard today.

---

## 7. Features Not Present in `tools/dashboard/`

Searched current `app.py` and backups — **not found** in this folder:

| Feature                                   | Status                                        |
| ----------------------------------------- | --------------------------------------------- |
| Ranch Bot                                 | Absent                                        |
| Telegram polling                          | Absent                                        |
| Time Machine monitoring                   | Absent                                        |
| Daily Executive Briefing                  | Absent                                        |
| Honcho memory panel                       | Removed (seen in `app.py.bad-honcho-route-*`) |
| Tab navigation (8 tabs)                   | Removed (seen in `app.py.before-fill-tabs-*`) |
| HA / PostgreSQL / Docker dedicated tabs   | Removed                                       |
| Temperature / Scrypted / benchmark panels | Removed (older snapshots only)                |

Those live elsewhere under `tools/` (watchdog, briefing, system_manager, etc.), not in `tools/dashboard/`.

---

## 8. Evolution (from snapshots)

The folder shows heavy iterative editing (May–Jun 2026):

| Phase     | Changes                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| Early May | Ollama host `192.168.50.117` → later `127.0.0.1`                                                |
| May 21    | Backup UI, resource monitor, M4 panel, benchmarks                                               |
| May 25–27 | Service health, tab bar (8 tabs), trend refresh                                                 |
| May 28    | Honcho panel added then removed                                                                 |
| May 30    | Dashboard hang bypass, drift warnings                                                           |
| Jun 2     | Storage charts, M4 memory/CPU metrics                                                           |
| Jun 4     | PropertyManager UI planned (`backup-before-propertymanager-ui`) but **not in current `app.py`** |
| Jun 9     | PropertyManager backup bundles created                                                          |

Current `app.py` is a **simplified single-page** layout vs. earlier multi-tab versions.

---

## 9. Dependencies and Deployment

- **Port:** `5051` (`app.run(host="0.0.0.0", port=5051)`)
- **systemd:** Expected unit at `~/.config/systemd/user/openclaw-dashboard.service`
- **venv:** `tools/dashboard/.venv` (Flask, matplotlib, numpy, requests)
- **Hardcoded paths:** `~/ai/projects/openclaw`, `~/openclaw-dashboard-backups`, M4 Tailscale IP, SSH key path

---

## 10. AI Model Scorecard Review Queue

The deployment-local dashboard includes an operator review surface at
`/ai-scorecard`.

The review workflow:

- discovers immutable `evaluation-lab-*.json` reports and displays the oldest
  undecided pipeline first;
- advances to the next archived undecided pipeline after a decision;
- links each promotion-eligible recommendation to a pipeline-specific,
  read-only evidence view;
- shows benchmark prompts, model responses, deterministic validation, reviewer
  scores, and findings when those source reports exist;
- labels fixture-only or missing evidence and warns the operator not to treat it
  as a real recommendation;
- presents direct Approve and Reject actions with optional audit notes;
- treats the decision-button click as confirmation;
- binds the submitted action to the pipeline shown on the page and passes the
  exact validated Evaluation Lab report path to the decision tool, so stale
  pages cannot decide another evaluation;
- restricts mutations to loopback requests;
- returns successful decisions to the clean review URL;
- preserves completed decisions and shows an explicit empty queue when no
  evidence-backed evaluation remains;
- leaves model routing disabled and does not modify the production model.

Promotion remains a separate action with explicit decision-ID confirmation.
The review queue does not generate synthetic evaluations. A new Evaluation Lab
report becomes the next review item.

### Scorecard routes

| Route                                       | Purpose                               |
| ------------------------------------------- | ------------------------------------- |
| `GET /ai-scorecard`                         | Current pending review or empty queue |
| `GET /ai-scorecard/evidence/<benchmark_id>` | Read-only decision evidence           |
| `POST /ai-scorecard/approve`                | Record pipeline approval              |
| `POST /ai-scorecard/reject`                 | Record pipeline rejection             |
| `POST /ai-scorecard/promote`                | Promote an approved scorecard         |

## 11. Gaps and Observations

1. **Dead code:** `build_system_health()` result is unused; service grid is missing from UI.
2. **Performance:** Six live Ollama tests on every page load can make the dashboard slow.
3. **PropertyManager:** Backup script exists; UI integration was started but not shipped.
4. **Not product OpenClaw:** Separate from `ui/` Control UI and Gateway `:18789`.
5. **Backup clutter:** 100+ `app.py.before-*` files and 12 propertymanager bundles dominate the folder.
6. **Scope boundary:** Ranch Bot, briefing, Time Machine, Telegram polling are **outside** this folder.

---

## Quick Reference

| Concern                         | Location                                       |
| ------------------------------- | ---------------------------------------------- |
| Main app                        | `tools/dashboard/app.py`                       |
| Run                             | `python app.py` → `:5051`                      |
| Charts                          | `reports/graphs/*.png`                         |
| Trends input                    | `reports/trends.csv`                           |
| Dashboard backups               | `~/openclaw-dashboard-backups/`                |
| Property backup script          | `tools/dashboard/dashboard_property_backup.sh` |
| PropertyManager data (external) | `tools/property_manager/`                      |

---

_Generated from static analysis of `tools/dashboard/` only. Does not cover the OpenClaw Control UI in `ui/` or Gateway dashboard at `:18789`._
