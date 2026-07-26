---
title: "OpenClaw Operations Runbook"
version: "1.1"
status: "Foundational"
owner: "OpenClaw Architecture"
last_reviewed: "2026-07-26"
category: "Operations"
source_document: "OPERATIONS_RUNBOOK.md"
---

# OpenClaw Operations Runbook

Version: 1.1
Status: Foundational
Owner: OpenClaw Architecture
Last Updated: 2026-07-26

---

# Purpose

This runbook defines the standard operating procedures for administering OpenClaw.

Its goals are to:

- provide repeatable operational procedures
- reduce recovery time
- improve consistency
- support both human operators and AI assistants

---

# Daily Operations

- Review Dashboard Health
- Review Backup Center
- Check watchdog status
- Review Daily Executive Briefing
- Confirm backup verification is healthy
- Investigate warnings before critical failures develop

---

# Weekly Operations

- Verify backup integrity
- Confirm restore verification reports
- Review disk utilization
- Review service health
- Review security updates
- Verify RanchBrain knowledge backups

---

# Monthly Operations

- Test a non-destructive restore preview
- Review foundational documentation
- Remove obsolete temporary files
- Audit AI logs
- Review backup retention
- Verify monitoring coverage

---

# Before Any Change

1. Confirm current Git branch
2. Review uncommitted changes
3. Create a backup if appropriate
4. Verify rollback strategy
5. Record significant architectural changes

---

# Incident Response

For any unexpected issue:

1. Assess impact
2. Preserve logs
3. Verify backups
4. Stabilize services
5. Restore only if necessary
6. Document root cause
7. Record lessons learned

---

# Service Recovery Order

1. PostgreSQL
2. Redis
3. OpenClaw services
4. Dashboard
5. PropertyManager API
6. Telegram integrations
7. RanchBrain services

---

# Dashboard WSGI Operations

The dashboard normally runs as the user service
`openclaw-dashboard.service`. Gunicorn is the WSGI master and supervises two
threaded workers.

Standard health checks:

```text
systemctl --user is-active openclaw-dashboard.service
systemctl --user status openclaw-dashboard.service
curl --fail http://127.0.0.1:5051/
```

Recent logs:

```text
journalctl --user -u openclaw-dashboard.service -n 100 --no-pager
```

Graceful configuration reload:

```text
systemctl --user reload openclaw-dashboard.service
```

Controlled restart:

```text
systemctl --user restart openclaw-dashboard.service
```

Before changing the service, preserve the installed unit, record the current
commit, and confirm the direct Flask rollback command is available. Production
changes still require operator testing and explicit deployment approval.

If the WSGI service cannot start:

1. Disable and stop `openclaw-dashboard.service`.
2. Restore the previous unit from the deployment rollback checkpoint.
3. As a temporary recovery measure only, start
   `.venv-dashboard/bin/python tools/dashboard/app.py`.
4. Confirm `http://127.0.0.1:5051/` returns HTTP 200.
5. Preserve Gunicorn and systemd logs before attempting another deployment.

The direct Flask server is a temporary rollback path, not an accepted steady
production state.

---

# Documentation Policy

Operational procedures should be updated whenever:

- architecture changes
- services are added
- recovery procedures change
- automation is introduced

Documentation is considered part of the system.

---

# Foundational Statement

Reliable systems are built through disciplined operations, not heroics.

Consistency is a feature.
