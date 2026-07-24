# OpenClaw Restore Manifest

Version: 1.0
Status: Foundational
Owner: OpenClaw Architecture
Last Updated: 2026-07-19

---

# Mission

The Restore Manifest defines the official disaster recovery policy for OpenClaw.

Every restore operation performed by OpenClaw, RanchBrain, PropertyManager, dashboard utilities, or future AI agents SHALL follow this document.

This document is the single source of truth for restore behavior.

---

# Core Principle

No restore operation may modify an OpenClaw system until:

1. The selected backup has passed archive verification.
2. The SHA-256 checksum has been verified.
3. A new safety snapshot of the current system has been successfully created.
4. The operator explicitly confirms the restore.

---

# Recovery Priorities

Priority 1

- OpenClaw repository
- RanchBrain knowledge
- PropertyManager
- Configuration
- Recovery scripts

Priority 2

- Dashboard
- AI services
- Home Assistant integrations
- Telegram services

Priority 3

- Historical reports
- Generated graphs
- Temporary runtime files
- Logs

---

# Restore Categories

## Always Restore

- Source code
- Configuration
- Documentation
- RanchBrain
- PropertyManager
- Dashboard
- Systemd units

## Optional Restore

- PostgreSQL databases
- pgvector indexes
- Redis persistence
- AI embeddings

These require explicit confirmation.

## Never Restore Automatically

- reports/
- logs/
- caches/
- temporary files
- PID files
- watchdog runtime state

These should be regenerated whenever possible.

---

# Mandatory Pre-Restore Checklist

Before every restore:

✓ Verify archive integrity

✓ Verify SHA-256 checksum

✓ Verify backup date

✓ Verify host

✓ Verify branch

✓ Verify available storage

✓ Create safety snapshot

✓ Stop required services

No restore proceeds until every item succeeds.

---

# Restore Order

1. Verify archive
2. Verify checksum
3. Create safety snapshot
4. Stop services
5. Restore files
6. Restore databases (optional)
7. Repair ownership
8. Repair permissions
9. Restart services
10. Execute health checks
11. Generate recovery report

---

# Rollback Policy

Rollback is automatic if:

- extraction fails
- checksum mismatch
- permissions cannot be repaired
- service startup fails
- health checks fail
- database restore fails

Rollback restores the safety snapshot created immediately before the restore.

---

# Successful Restore Definition

A restore is considered complete only when:

- Dashboard responds
- Backup Center healthy
- PostgreSQL healthy
- Redis healthy
- PropertyManager healthy
- Telegram bot healthy
- RanchBrain operational
- Health checks pass

---

# Audit Requirements

Every restore records:

- timestamp
- operator
- backup filename
- SHA-256
- git commit
- git branch
- services restarted
- verification results
- rollback status

---

# AI Governance

Every OpenClaw AI agent SHALL:

- verify before restoring
- create safety snapshots
- require confirmation
- log all recovery actions
- prefer preview before execution
- never overwrite unknown user data

---

# Future Roadmap

Planned enhancements include:

- Restore Preview
- Guided Restore Wizard
- Selective Restore
- Point-in-Time Database Restore
- Remote Restore
- Bare-Metal Recovery
- Disaster Recovery Automation

---

# Foundational Statement

The integrity of the current system is always protected before recovering the previous system.

Recovery exists to reduce risk—not create it.
