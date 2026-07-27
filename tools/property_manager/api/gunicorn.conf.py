"""Gunicorn policy for the OpenClaw PropertyManager API."""

import os


bind = f"0.0.0.0:{int(os.environ.get('PROPERTYMANAGER_API_PORT', '5062'))}"
workers = int(os.environ.get("PROPERTYMANAGER_GUNICORN_WORKERS", "2"))
worker_class = "gthread"
threads = int(os.environ.get("PROPERTYMANAGER_GUNICORN_THREADS", "4"))
timeout = int(os.environ.get("PROPERTYMANAGER_GUNICORN_TIMEOUT", "120"))
graceful_timeout = int(
    os.environ.get("PROPERTYMANAGER_GUNICORN_GRACEFUL_TIMEOUT", "30")
)
keepalive = 5
max_requests = int(os.environ.get("PROPERTYMANAGER_GUNICORN_MAX_REQUESTS", "1000"))
max_requests_jitter = int(
    os.environ.get("PROPERTYMANAGER_GUNICORN_MAX_REQUESTS_JITTER", "100")
)
accesslog = "-"
errorlog = "-"
capture_output = True
