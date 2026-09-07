feat(audit): record runtime skill selection metadata

## What Problem This Solves

OpenClaw has no visibility into which skills are selected during agent runs. When an agent processes a prompt, it may inject, select, or skip skills based on keyword matching, deterministic guards, or token overlap — but this selection process is opaque. Operators and developers cannot diagnose why a particular skill was chosen, whether it was triggered explicitly or naturally, or what confidence level the selection had.

Additionally, the bootstrap file filtering in `workspace.ts` only filtered `MEMORY.md` from private profile files, but not `USER.md`, which could leak private user context into shared sessions.

## Why This Change Was Made

This patch adds a `RuntimeSkillSelectionMarker` that is built after each agent attempt and emitted as an audit event. The marker captures:

- Which skill was selected (if any)
- The selection source: `explicit_trigger`, `natural_prompt`, or `none`
- The selection confidence: `deterministic`, `heuristic`, or `none`
- The selection rule: `explicit_trigger`, `deterministic_guardrail`, `token_overlap`, or `none`
- The visibility state: `selected`, `injected`, or `not_visible`

This enables:

1. **Audit trail** — operators can review which skills were used in past sessions
2. **Debugging** — developers can diagnose skill selection issues
3. **Quality metrics** — track skill selection accuracy over time

The privacy fix ensures both `MEMORY.md` and `USER.md` are filtered from bootstrap files in shared sessions.

## User Impact

- Operators can use `openclaw audit` to inspect skill selection events for past agent runs
- Gateway API exposes skill selection metadata through the audit endpoint
- Private user context (`USER.md`) is no longer leaked into shared bootstrap sessions
- No breaking changes to existing functionality

## Evidence

- **Unit tests**: `runtime-skill-selection.test.ts` (98 lines) — validates marker construction for explicit trigger, natural prompt, and no-skill scenarios
- **Unit tests**: `audit-events.test.ts` (47 lines) — validates audit event emission for skill selection
- **Unit tests**: `workspace.bootstrap-privacy.test.ts` (39 lines) — validates that both MEMORY.md and USER.md are filtered from bootstrap files
- **Integration**: The marker is emitted at the end of `completeEmbeddedAttemptResult()`, after all tool responses are collected, ensuring complete context
- **Privacy**: The filter function was renamed from `filterRootMemoryBootstrapFiles` to `filterNonPrivateRootProfileBootstrapFiles` for clarity

## Changed Files

- `src/skills/runtime-skill-selection.ts` — New module: `RuntimeSkillSelectionMarker` type and `buildRuntimeSkillSelectionMarker()` function (254 lines)
- `src/skills/runtime-skill-selection.test.ts` — Tests for the marker (98 lines)
- `src/agents/embedded-agent-runner/run/attempt-result.ts` — Integrates marker into attempt result, emits audit event
- `src/agents/workspace.ts` — Privacy fix: filter both MEMORY.md and USER.md from bootstrap files
- `src/agents/workspace.bootstrap-privacy.test.ts` — Tests for the privacy fix
- `src/audit/agent-event-audit.ts` — Extended audit event handling
- `src/audit/audit-event-store.ts` — Extended audit event store
- `src/audit/audit-event-types.ts` — New audit event types for skill selection
- `src/audit/audit-events.test.ts` — Tests for new audit events
- `src/commands/audit.ts` — Extended CLI audit command
- `src/gateway/server-methods/audit.ts` — Extended gateway audit API
- `packages/gateway-protocol/src/schema/audit.ts` — Extended protocol schema
- `packages/gateway-protocol/src/schema/audit.test.ts` — Tests for schema changes

## Test Plan

1. Run `pnpm build && pnpm check && pnpm test` in the fork
2. Verify skill selection markers appear in audit events after agent runs
3. Verify MEMORY.md and USER.md are both filtered from bootstrap files in shared sessions
4. Verify no regressions in existing skill injection behavior
