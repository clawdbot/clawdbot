# PropertyManager API — Development Runbook (Gunicorn WSGI)

Status: Development VM only  
Last Updated: 2026-07-29  
Scope: Isolated worktree `openclaw-cursor-propertymanager` on branch `cursor/propertymanager-ios`  
Do **not** apply this unit or procedure to the production Intel Mini without explicit operator approval.

---

## Runtime model

- **Framework:** Flask (routes, request/response, `MAX_CONTENT_LENGTH`)
- **Process manager:** Gunicorn WSGI (not Flask `app.run`, no debug, no autoreloader)
- **Entry:** `tools/property_manager/api/wsgi.py` → `application`
- **Gunicorn target:** `wsgi:application` with `WorkingDirectory=tools/property_manager/api`
- **Config:** `tools/property_manager/api/gunicorn.conf.py`
- **Launcher:** `tools/property_manager/api/run_api.sh`
- **Dev unit:** `tools/property_manager/deploy/propertymanager-api.service`

### Defaults

| Setting          | Value                                                        | Why                                                 |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| Bind             | `0.0.0.0:5062`                                               | Existing PropertyManager API port                   |
| Workers          | 2 × `sync`                                                   | Light API; docker-exec DB blocks per request        |
| Timeout          | 120s                                                         | Manual / meter / mapping ops via docker exec        |
| Graceful timeout | 90s                                                          | Drain in-flight docker-exec queries on stop/reload  |
| PID file         | `/tmp/pm-dev/propertymanager-api.pid`                        | Writable without privileges                         |
| Reloader         | off                                                          | systemd owns lifecycle                              |
| Upload limit     | 32 MiB (`MAX_CONTENT_LENGTH`)                                | Intentional ceiling                                 |
| systemd stop     | `TimeoutStopSec=120`, `KillMode=mixed`, `KillSignal=SIGTERM` | Gunicorn 26 graceful drain; master-only stop signal |

DB access defaults to **docker-exec-per-query** (`PROPERTYMANAGER_DB_VIA_DOCKER=1`). That pattern is process-safe across Gunicorn workers (no shared connections). Migrations are never run on import.

**Drain on full restart:** systemd uses `KillMode=mixed` + `KillSignal=SIGTERM`. On Gunicorn 26, SIGTERM to the master runs a graceful stop (workers finish the current request; `siginterrupt(SIGTERM, False)` keeps `docker exec` waits intact). SIGQUIT is a quick stop that calls `sys.exit` in the worker mid-request and produces HTTP 500. `db.py` tracks active docker-exec `Popen` handles and `worker_exit` waits up to `graceful_timeout`. After `TimeoutStopSec`, remaining cgroup processes are SIGKILLed — leftover tracked procs are terminate/kill'd so they are not orphaned indefinitely.

**Reload vs restart:** prefer `systemctl --user reload` (HUP) for code/config pickup. A full `restart` must still complete in-flight docker-exec requests within the graceful window (see `tests/test_restart_drain.py`).

---

## Install / restart (dev VM)

```bash
cd ~/ai/projects/openclaw-cursor-propertymanager
python3 -m venv tools/property_manager/api/.venv
tools/property_manager/api/.venv/bin/pip install -r tools/property_manager/api/requirements.txt

cp tools/property_manager/deploy/propertymanager-api.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart propertymanager-api.service
systemctl --user status propertymanager-api.service
```

Health:

```bash
curl -sS http://127.0.0.1:5062/health | python3 -m json.tool
```

Expect `status: ok`, `postgres_reachable: true`, `schema_available: true`, `schema_version: "006"`.

Logs:

```bash
journalctl --user -u propertymanager-api.service -n 100 --no-pager
```

Graceful reload / restart:

```bash
# Preferred for near-zero downtime (HUP: new workers up, old drain)
systemctl --user reload propertymanager-api.service

# Full restart — drains in-flight docker-exec (KillMode=mixed + worker_exit).
# Requests longer than graceful_timeout / TimeoutStopSec can still be killed.
systemctl --user restart propertymanager-api.service
```

---

## Rollback (dev VM)

1. Stop the Gunicorn unit: `systemctl --user stop propertymanager-api.service`
2. Restore the previous user unit from backup (if kept), **or** temporarily:
   ```bash
   PROPERTYMANAGER_ALLOW_FLASK_DEV=1 \
     tools/property_manager/api/.venv/bin/python \
     tools/property_manager/api/propertymanager_api.py
   ```
   Direct Flask is emergency-only (no debug/reloader).
3. Confirm `GET /health` returns HTTP 200.
4. Preserve journal + gunicorn logs before another attempt.

---

## Acceptance checklist (Andrew)

- [ ] `GET http://127.0.0.1:5062/health` → `status=ok`, postgres + schema true
- [ ] Process tree: one Gunicorn master, two sync workers, **no** Flask reloader child
- [ ] No “development server” / Werkzeug debugger warning in journal
- [ ] Meter reading create + task completion path works against **dev** DB
- [ ] `systemctl --user reload` and `restart` succeed
- [ ] Kill one worker PID → master respawns a replacement
- [ ] Shared tree `/home/gravesab/ai/projects/openclaw` and Intel Mini production untouched
- [ ] Explicit approval before any production Mini deploy

Dev URL: `http://127.0.0.1:5062` (Tailscale host URL as used by Mac/iOS for this VM).
