---
title: "Session, memory, and context engine Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (74%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (74%)`
- LTS Features: `6/9`

## Summary

This report promotes the archived `session-memory-and-context-engine` maturity evidence from `/Users/kevinlin/tmp/maturity/session-memory-and-context-engine` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                              | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                 |
| ------------------------------------------------------------------------------------- | --- | -------------- | -------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| [CLI Session and Transcript Management](cli-session-and-transcript-management.md)     | ✅  | `Beta (74%)`   | `Alpha (68%)`  | `Beta (74%)`   | CLI Session, Transcript Management                                                                   |
| [Token Management](compaction-pruning-and-token-pressure.md)                          | ✅  | `Beta (78%)`   | `Alpha (60%)`  | `Beta (78%)`   | Compaction, Pruning, Token Pressure                                                                  |
| [Context Engine](context-engine-and-runtime-assembly.md)                              | ✅  | `Beta (72%)`   | `Stable (80%)` | `Beta (72%)`   | Context Engine, Runtime Assembly                                                                     |
| [Cross-client History and Session Parity](cross-client-history-and-session-parity.md) | ❌  | `Beta (76%)`   | `Alpha (62%)`  | `Beta (76%)`   | Cross-client History, Session Parity                                                                 |
| [Diagnostics, Maintenance, and Recovery](diagnostics-maintenance-and-recovery.md)     | ❌  | `Beta (72%)`   | `Alpha (68%)`  | `Beta (72%)`   | Session diagnostic reports, Session maintenance warnings, Session and transcript recovery            |
| [Core Prompts and Context](instruction-profile-and-context-visibility.md)             | ✅  | `Alpha (68%)`  | `Beta (70%)`   | `Alpha (68%)`  | Instruction Profile, Context Visibility                                                              |
| [Memory](memory-files-tools-and-active-memory.md)                                     | ❌  | `Alpha (66%)`  | `Alpha (58%)`  | `Alpha (66%)`  | Memory Backend Storage, Embedding Search, Memory Files, Memory search and store tools, Active Memory |
| [Session Routing](session-routing-and-conversation-binding.md)                        | ✅  | `Stable (82%)` | `Beta (74%)`   | `Stable (82%)` | Session Routing, Conversation routing                                                                |
| [Transcript Persistence](transcript-persistence-and-durability.md)                    | ✅  | `Beta (78%)`   | `Alpha (58%)`  | `Beta (78%)`   | Transcript Persistence, Durability                                                                   |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. CLI Session and Transcript Management

Search anchors: CLI Session, Transcript Management, session, memory, and context engine cli session and transcript management, cli session and transcript management.

Category note: [CLI Session and Transcript Management](cli-session-and-transcript-management.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- CLI Session: Covers CLI Session across `openclaw sessions`, `openclaw transcripts`, cleanup, show/list/path behavior, TUI session history actions, and Gateway-backed session management commands.
- Transcript Management: Covers Transcript Management across `openclaw sessions`, `openclaw transcripts`, cleanup, show/list/path behavior, TUI session history actions, and Gateway-backed session management commands.

Primary docs:

- `docs/concepts/session.md`
- `docs/reference/session-management-compaction.md`
- `docs/cli/sessions.md`

### 2. Token Management

Search anchors: Compaction, Pruning, Token Pressure, session, memory, and context engine compaction, pruning, and token pressure, compaction, pruning, and token pressure.

Category note: [Token Management](compaction-pruning-and-token-pressure.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (60%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Compaction: Covers Compaction across manual and automatic compaction, preemptive overflow checks, context-window estimation, session pruning, tool-result trimming, compaction providers, retry/timeout behavior, and compacted transcript checkpoints.
- Pruning: Covers Pruning across manual and automatic compaction, preemptive overflow checks, context-window estimation, session pruning, tool-result trimming, compaction providers, retry/timeout behavior, and compacted transcript checkpoints.
- Token Pressure: Covers Token Pressure across manual and automatic compaction, preemptive overflow checks, context-window estimation, session pruning, tool-result trimming, compaction providers, retry/timeout behavior, and compacted transcript checkpoints.

Primary docs:

- `docs/concepts/compaction.md`
- `docs/concepts/context.md`
- `docs/reference/session-management-compaction.md`

### 3. Context Engine

Search anchors: Context Engine, Runtime Assembly, session, memory, and context engine context engine and runtime assembly, context engine and runtime assembly.

Category note: [Context Engine](context-engine-and-runtime-assembly.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Stable (80%)`
- Completeness: `Beta (72%)`
- LTS: ✅

Features:

- Context Engine: Covers Context Engine across context-engine selection, registry, host compatibility, legacy fallback, assemble/ingest/after-turn/compact lifecycle, runtime context projection, and the boundary between OpenClaw context assembly and native harness history.
- Runtime Assembly: Covers Runtime Assembly across context-engine selection, registry, host compatibility, legacy fallback, assemble/ingest/after-turn/compact lifecycle, runtime context projection, and the boundary between OpenClaw context assembly and native harness history.

Primary docs:

- `docs/concepts/context.md`
- `docs/concepts/context-engine.md`
- `docs/plan/codex-context-engine-harness.md`

### 4. Cross-client History and Session Parity

Search anchors: Cross-client History, Session Parity, session, memory, and context engine cross-client history and session parity, cross-client history and session parity.

Category note: [Cross-client History and Session Parity](cross-client-history-and-session-parity.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Alpha (62%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Cross-client History: Covers Cross-client History across `chat.history`, `chat.send`, WebChat display projection, TUI session actions, Android chat/session selection, OpenAI-compatible history mapping, channel history windows, and history visibility across reset/restart.
- Session Parity: Covers Session Parity across `chat.history`, `chat.send`, WebChat display projection, TUI session actions, Android chat/session selection, OpenAI-compatible history mapping, channel history windows, and history visibility across reset/restart.

Primary docs:

- `docs/web/webchat.md`
- `docs/platforms/android.md`
- `docs/channels/channel-routing.md`

### 5. Diagnostics, Maintenance, and Recovery

Search anchors: stuck-session diagnostics, restart recovery, orphaned subagent resume, diagnostic bundles, transcript repair, session maintenance warnings.

Category note: [Diagnostics, Maintenance, and Recovery](diagnostics-maintenance-and-recovery.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Session diagnostic reports: Covers stuck-session diagnostics, diagnostic bundles, stability snapshots, and operator visibility into transcript and session health.
- Session maintenance warnings: Covers restart maintenance warnings, delivery queues, memory/session cleanup signals, and operator-visible maintenance state.
- Session and transcript recovery: Covers restart recovery, orphaned subagent resume, transcript repair, and safe restoration of session state after failures.

Primary docs:

- `docs/gateway/diagnostics.md`
- `docs/reference/session-management-compaction.md`
- `docs/diagnostics/flags.md`

### 6. Core Prompts and Context

Search anchors: Instruction Profile, Context Visibility, session, memory, and context engine instruction profile and context visibility, instruction profile and context visibility.

Category note: [Core Prompts and Context](instruction-profile-and-context-visibility.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Beta (70%)`
- Completeness: `Alpha (68%)`
- LTS: ✅

Features:

- Instruction Profile: Covers Instruction Profile across `AGENTS.md`, `USER.md`, `IDENTITY.md`, `SOUL.md`, project context injection, bootstrap truncation, untrusted supplemental context, context visibility config, and runtime-context leakage prevention.
- Context Visibility: Covers Context Visibility across `AGENTS.md`, `USER.md`, `IDENTITY.md`, `SOUL.md`, project context injection, bootstrap truncation, untrusted supplemental context, context visibility config, and runtime-context leakage prevention.

Primary docs:

- `docs/concepts/context.md`
- `docs/reference/transcript-hygiene.md`
- `docs/channels/discord.md`

### 7. Memory

Search anchors: Memory Backend Storage, Embedding Search, Memory Files, memory search, memory get, memory store, Active Memory, root memory files, active memory, memory backend storage and embedding search.

Category note: [Memory](memory-files-tools-and-active-memory.md)

Score decisions:

- Coverage: `Alpha (66%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (66%)`
- LTS: ❌

Features:

- Memory Backend Storage: Covers Memory Backend Storage across memory backend config, SQLite schema, vector acceleration, embedding provider selection, remote embedding fetch, QMD process/query parsing, session transcript indexing for search, extra paths, and backend security boundaries.
- Embedding Search: Covers Embedding Search across memory backend config, SQLite schema, vector acceleration, embedding provider selection, remote embedding fetch, QMD process/query parsing, session transcript indexing for search, extra paths, and backend security boundaries.
- Memory Files: Covers Memory Files across root memory files, active memory, memory search/get/store tool exposure, memory prompt sections, memory flush plans, session-memory hook behavior, and memory plugin capability registration visible to agents.
- Memory search and store tools: Covers memory search/get/store tool exposure, memory prompt sections, memory flush plans, session-memory hook behavior, and memory plugin capability registration visible to agents.
- Active Memory: Covers Active Memory across root memory files, active memory, memory search/get/store tool exposure, memory prompt sections, memory flush plans, session-memory hook behavior, and memory plugin capability registration visible to agents.

Primary docs:

- `docs/reference/memory-config.md`
- `docs/concepts/memory-qmd.md`
- `docs/concepts/memory.md`
- `docs/channels/discord.md`

### 8. Session Routing

Search anchors: Session Routing, Conversation Binding, session, memory, and context engine session routing and conversation binding, session routing and conversation binding.

Category note: [Session Routing](session-routing-and-conversation-binding.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (74%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Session Routing: Covers Session Routing across `sessionKey` construction, target resolution, conversation bindings, session labels, per-conversation isolation, thread binding, model selection continuity tied to sessions, and agent/workspace store targeting.
- Conversation routing: Covers Conversation Binding across `sessionKey` construction, target resolution, conversation bindings, session labels, per-conversation isolation, thread binding, model selection continuity tied to sessions, and agent/workspace store targeting.

Primary docs:

- `docs/concepts/session.md`
- `docs/channels/channel-routing.md`
- `docs/channels/discord.md`

### 9. Transcript Persistence

Search anchors: Transcript Persistence, Durability, session, memory, and context engine transcript persistence and durability, transcript persistence and durability.

Category note: [Transcript Persistence](transcript-persistence-and-durability.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (58%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Transcript Persistence: Covers Transcript Persistence across JSONL session files, transcript append and redaction, session write locks, transcript rotation/archive behavior, disk budget cleanup, provider transcript stores, and restart/repair durability.
- Durability: Covers Durability across JSONL session files, transcript append and redaction, session write locks, transcript rotation/archive behavior, disk budget cleanup, provider transcript stores, and restart/repair durability.

Primary docs:

- `docs/reference/session-management-compaction.md`
- `docs/reference/transcript-hygiene.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/session-memory-and-context-engine/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/session-memory-and-context-engine`.
