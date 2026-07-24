# OpenClaw Operations Runbook

Version: 1.0
Status: Foundational
Owner: OpenClaw Architecture
Last Updated: 2026-07-19

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
