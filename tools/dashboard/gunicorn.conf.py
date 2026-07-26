"""Conservative Gunicorn settings for the OpenClaw dashboard."""

import os


bind = os.environ.get("OPENCLAW_DASHBOARD_BIND", "0.0.0.0:5051")
workers = int(os.environ.get("OPENCLAW_DASHBOARD_WORKERS", "2"))
threads = int(os.environ.get("OPENCLAW_DASHBOARD_THREADS", "4"))
worker_class = "gthread"

timeout = int(os.environ.get("OPENCLAW_DASHBOARD_TIMEOUT", "300"))
graceful_timeout = 45
keepalive = 5

max_requests = 1000
max_requests_jitter = 100
preload_app = False

accesslog = "-"
errorlog = "-"
capture_output = True
loglevel = os.environ.get("OPENCLAW_DASHBOARD_LOG_LEVEL", "info")

proc_name = "openclaw-dashboard"
