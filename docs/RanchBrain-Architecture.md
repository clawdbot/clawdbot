# RanchBrain Version 1.0 Architecture

## Mission

RanchBrain is the local-first knowledge and intelligence layer for RedBud Ranch and OpenClaw.

## Core Modules

- System Memory
- Ranch Budget
- Property Memory
- Health Memory
- Home Assistant Memory
- Project Memory

## Version 1.0 Goals

1. Create a clean RanchBrain structure.
2. Build a Python ingestion engine.
3. Import existing system reports.
4. Create searchable metadata.
5. Add budget CSV import foundation.
6. Add simple CLI commands.

## Storage Plan

- Markdown for human-readable memory.
- JSON metadata for structured indexing.
- PostgreSQL and pgvector later.

## PropertyManager asset join

RanchBrain JSON assets include `propertymanager_asset_id` and `asset_id` (e.g. `EQ-DEERE-MOWER-001`). PropertyManager Postgres owns operational meter readings and meter-based PM schedules. The join key is `propertymanager.assets.external_id` matching RanchBrain `asset_id`.

**Authoritative docs (Phase 0 — implementation blocked until operator approval):**

- [PropertyManager Foundational Requirements](foundation/PROPERTY_MANAGER_FOUNDATIONAL_REQUIREMENTS.md) — dev/prod gates, audit requirements, test matrix
- [PropertyManager Asset Architecture](architecture/PROPERTY_MANAGER_ASSET_ARCHITECTURE.md) — entity model, API, client topology

Task→asset matching is **review-only**: import generates a mapping report; matches apply only after operator approval (no auto-apply by area/item).

## First CLI Commands

- ranchbrain status
- ranchbrain ingest system
- ranchbrain search "query"
