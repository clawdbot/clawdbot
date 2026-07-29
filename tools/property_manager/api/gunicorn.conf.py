"""Conservative Gunicorn settings for the PropertyManager API (development VM).

Worker rationale:
- ``sync`` workers: DB access is docker-exec-per-query (blocking I/O per request).
  Threads would not overlap usefully inside one worker for that path.
- Two workers: light REST API; enough to survive one blocked/long request.
- 120s timeout: meter confirm / mapping / manual ops can be slow via docker exec.
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
graceful_timeout = int(os.environ.get("PROPERTYMANAGER_API_GRACEFUL_TIMEOUT", "30"))
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
