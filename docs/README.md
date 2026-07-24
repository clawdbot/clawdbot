---
title: "OpenClaw Documentation Center"
version: "1.0"
status: "Active"
owner: "OpenClaw Architecture"
last_reviewed: "2026-07-19"
category: "Documentation Index"
---

# OpenClaw Documentation Center

This directory is the authoritative home for maintained OpenClaw documentation.

The original root-level documents are temporarily retained during migration. New tools, dashboard pages, and RanchBrain indexing should use the files under `docs/`.

## Documentation hierarchy

### Foundation

Foundational documents define mission, governance, philosophy, operations, and recovery policy.

- [Foundational Documentation Index](foundation/FOUNDATIONAL_DOCUMENTS.md)
- [Project Overview](foundation/PROJECT_OVERVIEW.md)
- [Operational Philosophy](foundation/SOUL.md)
- [AI Governance Manifest](foundation/AI_GOVERNANCE_MANIFEST.md)
- [Restore Manifest](foundation/RESTORE_MANIFEST.md)
- [Operations Runbook](foundation/OPERATIONS_RUNBOOK.md)

### Architecture

Architecture documents describe system structure and implementation context.

- [RanchBot Architecture](architecture/RANCHBOT_ARCHITECTURE.md)
- [Dashboard Report](architecture/DASHBOARD_REPORT.md)
- [Project Context](architecture/PROJECT_CONTEXT.md)
- [Tools and Engineering Practices](architecture/TOOLS.md)

### Reserved documentation areas

- `runbooks/` — detailed operational procedures
- `adr/` — architecture decision records
- `api/` — API specifications and contracts
- `user/` — operator and user guides
- `assets/` — diagrams and supporting documentation assets

## Governance

Implementation must not contradict foundational governance.

Documents should use standardized YAML metadata so the dashboard and RanchBrain can identify their title, version, status, owner, review date, and category.

## Migration status

Root-level source documents remain in place until:

1. the Documentation Center dashboard is operational,
2. RanchBrain indexes the new paths,
3. internal links are verified,
4. the operator approves removal of duplicate root copies.
