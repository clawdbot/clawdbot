"""Conservative Gunicorn settings for the PropertyManager API (development VM).

Worker rationale:
- ``sync`` workers: DB access is docker-exec-per-query (blocking I/O per request).
  Threads would not overlap usefully inside one worker for that path.
- Two workers: light REST API; enough to survive one blocked/long request.
- 120s timeout: meter confirm / mapping / manual ops can be slow via docker exec.
- Graceful timeout defaults to 90s so in-flight ``docker exec … psql`` can finish
  before workers are SIGKILLed on stop/reload. ``worker_exit`` waits on tracked
  docker-exec children via ``db.wait_inflight_docker_execs``. Prefer
  ``systemctl reload`` (HUP) for near-zero downtime. Full restart drains when
  systemd uses ``KillMode=mixed`` and ``KillSignal=SIGTERM`` (Gunicorn 26
  graceful path). Do not use SIGQUIT as the unit KillSignal — that is a quick
  stop that aborts in-flight requests.
- No autoreloader: systemd owns restarts; reload is ``kill -HUP`` / systemctl reload.
"""

from __future__ import annotations

import os
from pathlib import Path

_PID_DIR = Path(os.environ.get("PROPERTYMANAGER_PID_DIR", "/tmp/pm-dev"))
_PID_DIR.mkdir(parents=True, exist_ok=True)

_port = os.environ.get("PROPERTYMANAGER_API_PORT", "5062").strip() or "5062"
bind = os.environ.get("PROPERTYMANAGER_API_BIND", f"0.0.0.0:{_port}")

workers = int(os.environ.get("PROPERTYMANAGER_API_WORKERS", "2"))
worker_class = "sync"

timeout = int(os.environ.get("PROPERTYMANAGER_API_TIMEOUT", "120"))
graceful_timeout = int(os.environ.get("PROPERTYMANAGER_API_GRACEFUL_TIMEOUT", "90"))
keepalive = 5

# Explicitly disable the development autoreloader.
reload = False
preload_app = False

max_requests = int(os.environ.get("PROPERTYMANAGER_API_MAX_REQUESTS", "1000"))
max_requests_jitter = int(os.environ.get("PROPERTYMANAGER_API_MAX_REQUESTS_JITTER", "50"))

accesslog = "-"
errorlog = "-"
capture_output = True
loglevel = os.environ.get("PROPERTYMANAGER_API_LOG_LEVEL", "info")

pidfile = str(_PID_DIR / "propertymanager-api.pid")
proc_name = "propertymanager-api"


def worker_exit(server, worker):  # noqa: ANN001 — Gunicorn hook signature
    """Wait for tracked docker-exec children before the worker process exits."""
    try:
        import db as pm_db

        remaining = pm_db.wait_inflight_docker_execs(timeout=float(graceful_timeout))
        if remaining:
            server.log.warning(
                "worker_exit: %s docker-exec process(es) still alive after drain",
                remaining,
            )
    except Exception as exc:  # pragma: no cover - defensive logging only
        server.log.warning("worker_exit docker-exec drain failed: %s", exc)
