feat(audit): record observed runtime skill usage

## What Problem This Solves

OpenClaw can emit skill-usage diagnostics while an agent reads or invokes a skill, but that observed runtime signal is not available through the durable audit surface. Operators therefore cannot inspect which skills were actually used during a run from the audit CLI/API.

This also keeps the shared-session bootstrap privacy hardening from the earlier revision: root `MEMORY.md` and `USER.md` profile aliases are excluded from shared channel/group bootstrap context, while private cron/subagent paths retain the profile files they are allowed to use.

## Why This Change Was Made

The first revision inferred skill selection from prompt text after attempt completion. Review correctly called that out as the wrong boundary: prompt inference is not proof of skill use and it also risked perturbing the embedded attempt-result contract.

This revision records only observed runtime skill usage from the existing `before_tool_call` skill-usage boundary:

- Skill read/command activation is detected where `recordRunSkillUsage()` already emits runtime diagnostics.
- A metadata-only `skill_selection` audit event is emitted with `selectionSource: "observed_runtime"` and `selectionConfidence: "observed"`.
- No prompt text, tool arguments, tool output, or skill file contents are persisted.
- `skill_selection` is persisted outside run-start deduplication so it is not dropped after `agent.run.started`.
- Legacy `audit.list` remains run/tool-only; the versioned `audit.activity.list` surface exposes skill-selection records.
- `completeEmbeddedAttemptResult()` is restored to the production calling contract, preserving the existing truncated-stream/tool recovery behavior.

## User Impact

- `openclaw audit --kind skill_selection` can show observed skill usage for a run through the activity-list API.
- Existing `audit.list` clients keep their shipped run/tool event shape and do not receive the new record kind.
- Operators get a durable metadata trail for actual skill usage without sensitive prompt or file-content capture.
- Shared Discord/Telegram channel sessions no longer receive root `USER.md`/`MEMORY.md` bootstrap profile files by alias.

## Evidence

Targeted validation run:

```bash
pnpm tsgo:core
pnpm test src/skills/runtime-skill-selection.test.ts src/audit/audit-events.test.ts packages/gateway-protocol/src/schema/audit.test.ts src/gateway/server-methods/audit.test.ts src/commands/audit.test.ts src/agents/agent-tools.before-tool-call.e2e.test.ts src/agents/embedded-agent-runner/run/attempt-result.test.ts
```

Results:

- `pnpm tsgo:core` passed.
- Targeted Vitest run passed 7 shards in 257.06s.
- `runtime-skill-selection.test.ts`: 2 tests passed.
- `audit-events.test.ts`: 51 tests passed, including observed skill use between lifecycle start and terminal events.
- `server-methods/audit.test.ts`: 32 tests passed, including `audit.activity.list` returning skill-selection and legacy `audit.list` filtering it out.
- `audit.test.ts`: 7 protocol schema tests passed, including legacy rejection and activity schema discrimination.
- `commands/audit.test.ts`: 34 tests passed, including CLI rendering of `skill_selection ... observed ... skill:debug-toolkit`.
- `agent-tools.before-tool-call.e2e.test.ts`: 103 tests passed, including the real skill-read boundary emitting a metadata-only audit event.
- `attempt-result.test.ts`: 37 tests passed after restoring the upstream attempt-result implementation.

`pnpm check` / `pnpm check:changed` were also attempted. They currently fail on existing repository-wide ratchets unrelated to this patch (`extensions/workboard` max-lines/assertion-safety baseline shrink); the targeted tests and core typecheck for this change pass.

## Changed Files

- `src/skills/runtime-skill-selection.ts` — observed-only metadata marker.
- `src/agents/agent-tools.before-tool-call.wrapper.ts` — emits `skill_selection` from the existing observed skill-usage boundary.
- `src/audit/agent-event-audit.ts` — projects observed-only skill-selection records and routes them outside run-start deduplication.
- `src/audit/audit-event-store.ts` / `src/audit/audit-event-types.ts` — durable store/types for observed skill-selection metadata.
- `src/gateway/server-methods/audit.ts` — exposes skill-selection through `audit.activity.list` while preserving legacy `audit.list`.
- `packages/gateway-protocol/src/schema/audit-activity.ts` — versioned activity schema includes `skill_selection`.
- `packages/gateway-protocol/src/schema/audit.ts` — legacy audit schema stays run/tool-only.
- `src/commands/audit.ts` — CLI uses the activity surface and renders selected skill metadata.
- `src/agents/workspace.ts` — shared-session bootstrap privacy filtering for root profile aliases.

## Test Plan

1. Verify observed skill reads/commands emit `skill_selection` audit events.
2. Verify `skill_selection` persists between run start and terminal events.
3. Verify `audit.activity.list` and CLI expose skill-selection records.
4. Verify legacy `audit.list` remains run/tool-only.
5. Verify attempt-result recovery tests still pass.
6. Verify shared-session bootstrap privacy behavior.
