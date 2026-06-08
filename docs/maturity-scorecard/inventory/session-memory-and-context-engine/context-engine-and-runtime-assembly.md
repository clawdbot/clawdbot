---
title: "Session, memory, and context engine - Context Engine Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Context Engine Maturity Note

## Summary

The context-engine contract is first-class: docs describe lifecycle hooks,
source defines a typed interface and registry, and runtime helpers wire engines
into embedded and CLI runs. Archive evidence is comparatively quiet for current
user pain, but the Codex app-server harness remains a documented parity gap and
engine-owned compaction semantics remain easy to misuse.

## Category Scope

This category covers context-engine selection, registry, host compatibility,
legacy fallback, assemble/ingest/after-turn/compact lifecycle, runtime context
projection, and the boundary between OpenClaw context assembly and native
harness history.

## Features

- Context Engine: Covers Context Engine across context-engine selection, registry, host compatibility, legacy fallback, assemble/ingest/after-turn/compact lifecycle, runtime context projection, and the boundary between OpenClaw context assembly and native harness history.
- Runtime Assembly: Covers Runtime Assembly across context-engine selection, registry, host compatibility, legacy fallback, assemble/ingest/after-turn/compact lifecycle, runtime context projection, and the boundary between OpenClaw context assembly and native harness history.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: docs, interface, registry, host compatibility, delegation helpers, and CLI lifecycle tests are present.
- Negative signals: current coverage is strongest at unit/runtime-helper level; fewer full user scenarios prove plugin engines across all harnesses and subagent lifecycle paths.
- Integration gaps: add a fixture context-engine plugin scenario for embedded OpenClaw, CLI runner, Codex app-server projection, manual `/compact`, and subagent fork/cleanup.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports: the exact context-engine issue query returned no results.
- Discrawl reports: Discord archive records context-engine docs, contract validation, and user guidance; the main risk reported was opaque contract failures before validation and Codex/harness parity.
- Good qualities: the contract is explicit, fail-fast validation exists, and docs warn that no-op compaction on an active engine is unsafe.
- Bad qualities: Codex native thread history remains a separate state owner, so projecting OpenClaw context into that harness is inherently constrained.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Context Engine, Runtime Assembly.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Codex app-server context-engine lifecycle parity is specified but not fully documented as complete.
- Engine-owned compaction requires careful operator/plugin author choices.

## Evidence

### Docs

- `docs/concepts/context.md:166` says OpenClaw delegates assembly, `/compact`, and related subagent lifecycle hooks to the active engine.
- `docs/concepts/context-engine.md:70` lists lifecycle points; `docs/concepts/context-engine.md:178` documents the interface; `docs/concepts/context-engine.md:254` explains `ownsCompaction`.
- `docs/plan/codex-context-engine-harness.md:16` describes the Codex harness parity goal and `docs/plan/codex-context-engine-harness.md:115` says Codex app-server remains canonical for native thread state.

### Source

- `src/context-engine/types.ts:230` defines the `ContextEngine` contract.
- `src/context-engine/registry.ts:374` registers engines; `src/context-engine/registry.ts:527` resolves active engines; `src/context-engine/registry.ts:454` validates required methods.
- `src/context-engine/host-compat.ts:21` defines embedded host support and `src/context-engine/host-compat.ts:34` defines Codex app-server host support.
- `src/context-engine/delegate.ts:33` lets non-owning engines delegate compaction to runtime.

### Integration tests

- `src/agents/cli-runner.context-engine.test.ts:145` finalizes successful CLI turns with the active context engine.
- `src/agents/cli-runner.context-engine.test.ts:256` loads unbounded context-engine history separately from hook history.
- `src/agents/embedded-agent-runner/run/attempt.spawn-workspace.context-engine.test.ts` covers context-engine propagation in spawned workspaces.

### Unit tests

- `src/context-engine/context-engine.test.ts:386` registers and resolves a mock engine.
- `src/context-engine/context-engine.test.ts:415` verifies `delegateCompactionToRuntime`.
- `src/agents/harness/context-engine-lifecycle.test.ts:50` keeps hidden runtime-context messages out of assemble hooks.

### Gitcrawl queries

Query:

`gitcrawl search issues "context engine compact plugins.slots.contextEngine" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned `[]`.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "context engine compact plugins.slots.contextEngine"`

Results:

- Returned context-engine docs and support discussion, a contract-validation PR comment, and discussion of `plugins.slots.contextEngine` for dynamic per-turn context selection.
