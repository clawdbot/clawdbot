---
title: "OpenClaw Python Web Runtime Inventory"
version: "1.0"
status: "Architecture"
owner: "OpenClaw Architecture"
last_reviewed: "2026-07-26"
category: "Runtime"
source_document: "PYTHON_WEB_RUNTIME_INVENTORY.md"
---

# OpenClaw Python Web Runtime Inventory

## Purpose

This document identifies Python web applications and how they are served. It
distinguishes the application framework from the production server:

- Flask is the application framework and remains supported.
- Gunicorn is the approved WSGI server for Flask applications.
- Flask's built-in `app.run()` server is for local development only.
- A future FastAPI or other ASGI application must use an approved ASGI server,
  such as Uvicorn under a supervised service.

This inventory does not authorize deployment. Runtime changes must be
implemented and accepted in development before a separately approved production
deployment.

## Inventory Snapshot

| Application         | Framework          | Development runtime              | Production runtime                        | Port        | Status                        |
| ------------------- | ------------------ | -------------------------------- | ----------------------------------------- | ----------- | ----------------------------- |
| OpenClaw Dashboard  | Flask / WSGI       | Gunicorn, two `gthread` workers  | Gunicorn, two `gthread` workers           | 5051        | Compliant                     |
| PropertyManager API | Flask / WSGI       | Not active during inventory      | Flask built-in debug server with reloader | 5062        | Migration required            |
| OpenClaw Gateway    | Node.js            | Node.js service                  | Node.js service                           | 18789/18790 | Not a Python WSGI/ASGI target |
| Control UI          | Vite build tooling | Development/preview tooling only | Served through the OpenClaw stack         | n/a         | Not a Python WSGI/ASGI target |

No FastAPI, Django, or aiohttp application was found in the maintained Python
source during this inventory.

Two dashboard installer utilities contain Flask-aware source-editing logic but
are not web servers.

## Verified Runtime Findings

### Dashboard

The dashboard exposes `tools.dashboard.wsgi:application` and is launched by
Gunicorn from its supervised service definition. Both development and
production were observed with one Gunicorn master and two workers.

The `app.run()` block at the end of `tools/dashboard/app.py` is not used by the
supervised service. It remains a developer convenience and must not be used as
a deployment entry point.

### PropertyManager API

`tools/property_manager/api/propertymanager_api.py` is a Flask application. Its
direct entry point starts:

```text
app.run(host="0.0.0.0", port=port, debug=True)
```

The production service currently invokes `run_api.sh`, which launches that
Python file directly. The observed runtime therefore uses Flask's development
server, enables the debug reloader, and creates two Python processes. The
service is supervised, but the HTTP server itself is not production-grade.

The API source and launch script were uncommitted work when this inventory was
performed. They must not be overwritten or folded into an unrelated migration.

## Required PropertyManager Migration

Implement and prove the following on the development branch and development VM:

1. Add a side-effect-free WSGI entry point exporting the Flask application.
2. Add Gunicorn to the PropertyManager API's pinned runtime dependencies.
3. Add a dedicated Gunicorn configuration with bounded workers/threads,
   request timeout, graceful shutdown, worker recycling, and access/error logs.
4. Replace direct Python execution in the service definition with Gunicorn.
5. Remove `debug=True` from any retained local-only launcher, or require an
   explicit development flag that defaults off.
6. Add focused tests for import safety, binding, worker policy, timeout,
   graceful shutdown, restart behavior, and absence of debug mode in managed
   launches.
7. Test database reads, writes, completion updates, health checks, attachment
   paths, malformed requests, concurrent requests, worker replacement, and
   full service recovery in development.
8. Have the operator test the iPhone workflow against development.
9. Commit and push only to `development`.
10. Prepare a production checkpoint and rollback package. Deploy only after
    explicit operator approval.

## Reliability Acceptance Gates

The PropertyManager migration is ready for operator testing only when:

- the development service survives a worker termination;
- the service manager restores the full service after a master termination;
- no request starts Flask debug mode or a reloader;
- health and CRUD behavior match the pre-migration API;
- database changes remain transactional and auditable;
- attachment storage remains outside the application process;
- logs contain actionable errors without credentials or sensitive payloads;
- focused tests and applicable repository checks pass.

## Recommended Migration Order

1. PropertyManager API WSGI entry point and Gunicorn configuration.
2. Development-only systemd service and runtime tests.
3. iPhone and dashboard integration testing in development.
4. Operator acceptance.
5. Production checkpoint with backup and rollback verification.
6. Separately approved production deployment.

The dashboard requires no further server replacement. The next implementation
phase should focus only on PropertyManager API reliability.
