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

## First CLI Commands

- ranchbrain status
- ranchbrain ingest system
- ranchbrain search "query"
