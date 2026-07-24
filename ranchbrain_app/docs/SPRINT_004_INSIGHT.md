# RanchBrain 1.0 Alpha

# Sprint 004 Plan

**Codename:** Insight

**Started:** 2026-07-10

---

## Mission

Add the first intelligence-layer capabilities to RanchBrain.

Sprint 004 begins with configuration and incremental indexing, then prepares for relationships, semantic search, and OpenClaw integration.

---

## Phase 0 - Configuration System

Goals:

- Centralize RanchBrain settings
- Define configurable paths
- Prepare for Ollama, embeddings, and future integrations

Planned config file:

- ranchbrain/ranchbrain.yaml

---

## Phase A - Incremental Indexing

Goals:

- Avoid full reindexing when files have not changed
- Detect new, changed, and deleted files
- Keep profile indexes fast and scalable

---

## Phase B - Memory Relationships

Goals:

- Link memories together
- Support related, follow_up, duplicate_of, caused_by, parent, child, references

---

## Phase C - Automatic Memory Extraction

Goals:

- Convert OpenClaw reports into structured memories
- Reduce manual entry

---

## Phase D - Semantic Search

Goals:

- Add local embeddings
- Use Ollama models such as nomic-embed-text
- Search by meaning, not only exact words

---

## Phase E - RanchBrain Answer

Goals:

- Retrieve relevant memories
- Produce grounded answers using local context

---

## Phase F - OpenClaw Integration

Goals:

- Let OpenClaw call RanchBrain
- Add memory-backed Telegram answers
- Feed executive briefings into RanchBrain automatically

---

## Sprint 004 First Task

Implement configuration system.

Status: Started
