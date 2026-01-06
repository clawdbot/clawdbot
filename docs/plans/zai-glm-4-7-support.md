---
summary: "Exec spec: Z.AI GLM-4.7 integration (provider normalization + docs + CLI/tests)"
status: "complete"
owner: "peter"
updated: "2026-01-06"
---

# Exec spec: Z.AI GLM-4.7 integration

## Problem
Users configure Z.AI with `z.ai/*`, `z-ai/*`, or uppercase provider ids (e.g. `Z.AI/*`).
Clawdbot expects canonical `zai`, which leads to mismatches across config, CLI,
allowlists, fallbacks, and docs.

## Goals
- Accept `z.ai/*` and `z-ai/*` as provider aliases for Z.AI.
- Normalize provider ids to lowercase, then map aliases to canonical `zai`.
- Ensure normalization works across config parsing, CLI, allowlists, fallbacks.
- Add explicit Z.AI documentation (env var, canonical model id, alias note).
- Add tests to prevent regressions.

## Non-goals
- No provider runtime changes (pi-ai already supports Z.AI).
- No OAuth; API key only.
- No default model changes.
- No UI changes outside docs.

## Success criteria
- `agent.model: "z.ai/glm-4.7"` resolves to `zai/glm-4.7`.
- Provider casing is normalized (`Z.AI/*` → `zai/*`).
- CLI `models set`/fallbacks accept alias inputs and persist canonical `zai/*`.
- Docs show Z.AI setup + alias behavior.
- Tests cover normalization and CLI set/fallbacks.

## Implementation plan (multi-phase todo)

### Phase 0 — Discovery + constraints
- [x] Identify normalization entry point (`parseModelRef`).
- [x] Confirm Z.AI provider id in catalog is `zai`.
- [x] Confirm env var `ZAI_API_KEY` usage in docs.

### Phase 1 — Core implementation
- [x] Add provider normalization helper in `src/agents/model-selection.ts`.
- [x] Normalize provider ids to lowercase.
- [x] Map `z.ai` and `z-ai` to canonical `zai`.
- [x] Apply normalization to both explicit provider and default provider paths.

### Phase 2 — CLI + config coverage
- [x] Ensure CLI model parsing uses normalized provider ids.
- [x] Validate allowlists/fallbacks flow through normalized parsing.

### Phase 3 — Tests
- [x] Add unit tests for `z.ai` and `z-ai` provider normalization.
- [x] Add unit tests for provider case normalization.
- [x] Add CLI tests for `models set` + fallbacks normalization.
- [x] Add CLI coverage for `models status` and `models list` canonical output.
- [x] Add CLI coverage for `models status --plain` and `models list --plain`.
- [x] Add CLI coverage for `models list --provider z.ai` filter normalization.

### Phase 4 — Docs
- [x] Update `docs/configuration.md` with Z.AI setup snippet.
- [x] Document alias support (`z.ai`, `z-ai`) and canonical `zai`.
- [x] Note Z.AI endpoint variants + built-in provider base URL.
- [x] Add/refresh Z.AI mention in `docs/models.md`.
- [x] Add UX note for missing `ZAI_API_KEY` auth errors.

### Phase 5 — Verification
- [x] Run unit tests (CLI + model parsing).
- [x] Run full test suite (`pnpm test`).
- [x] Verify `models status`/`models list` JSON output uses `zai/*`.
- [x] Confirm PR narrative matches Z.AI integration scope.

## Files touched
- `src/agents/model-selection.ts`
- `src/agents/model-selection.test.ts`
- `src/commands/models.set.test.ts`
- `docs/configuration.md`
- `docs/models.md`

## Risks
- Canonical output shows `zai` rather than `z.ai` (intentional but may surprise).
- Future alias collisions if additional aliases are added without review.

## Rollback plan
- Revert normalization helper and alias tests.
- Revert Z.AI doc updates.

## Verification log
- Tests: `pnpm test` (pass; 2 skipped live tests).
