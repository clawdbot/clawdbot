# RanchBrain 1.0 Alpha Architecture

Codename: Foundation

## Mission

RanchBrain is the local-first memory and intelligence engine for RedBud Ranch.

OpenClaw uses RanchBrain for long-term knowledge, search, reasoning, budgeting, property history, health notes, and executive intelligence.

## Separation of Responsibilities

OpenClaw:

- automation
- watchdogs
- Telegram
- Home Assistant integration
- dashboards
- service monitoring

RanchBrain:

- memory
- indexing
- search
- budget tracking
- property knowledge
- health knowledge
- project history
- reasoning support

## Core Components

1. CLI
2. Memory Engine
3. Ingestion Engine
4. Search Engine
5. Budget Engine
6. Property Engine
7. Health Engine
8. Executive Intelligence

## Storage

Phase 1:

- Markdown
- JSON metadata
- local files

Future:

- PostgreSQL
- pgvector
- semantic search

## Rule

Every RanchBrain feature must create knowledge, improve knowledge, or use knowledge to make a better decision.
