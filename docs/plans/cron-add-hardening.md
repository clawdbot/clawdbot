---
summary: "Harden cron.add input handling, align schemas, and improve cron UI/agent tooling"
owner: "clawdbot"
status: "complete"
last_updated: "2026-01-05"
---

# Cron Add Hardening & Schema Alignment

## Context
Recent gateway logs show repeated `cron.add` failures with invalid parameters (missing `sessionTarget`, `wakeMode`, `payload`, and malformed `schedule`). This indicates that at least one client (likely the agent tool call path) is sending wrapped or partially specified job payloads. Separately, there is drift between cron channel enums in TypeScript, gateway schema, CLI flags, and UI form types, plus a UI mismatch for `cron.status` (expects `jobCount` while gateway returns `jobs`).

## Goals
- Stop `cron.add` INVALID_REQUEST spam by normalizing common wrapper payloads and inferring missing `kind` fields.
- Align cron channel lists across gateway schema, cron types, CLI docs, and UI forms.
- Make agent cron tool schema explicit so the LLM produces correct job payloads.
- Fix the Control UI cron status job count display.
- Add tests to cover normalization and tool behavior.

## Non-goals
- Change cron scheduling semantics or job execution behavior.
- Add new schedule kinds or cron expression parsing.
- Overhaul the UI/UX for cron beyond the necessary field fixes.

## Findings (current gaps)
- `CronPayloadSchema` in gateway excludes `signal` + `imessage`, while TS types include them.
- Control UI CronStatus expects `jobCount`, but gateway returns `jobs`.
- Agent cron tool schema allows arbitrary `job` objects, enabling malformed inputs.
- Gateway strictly validates `cron.add` with no normalization, so wrapped payloads fail.

## Proposed Approach
1. **Normalize** incoming `cron.add` payloads (unwrap `data`/`job`, infer `schedule.kind` and `payload.kind`, default `wakeMode` + `sessionTarget` when safe).
2. **Harden** the agent cron tool schema using the canonical gateway `CronAddParamsSchema` and normalize before sending to the gateway.
3. **Align** channel enums and cron status fields across gateway schema, TS types, CLI descriptions, and UI form controls.
4. **Test** normalization in gateway tests and tool behavior in agent tests.

## Multi-phase Execution Plan

### Phase 1 — Schema + type alignment
- [x] Expand gateway `CronPayloadSchema` channel enum to include `signal` and `imessage`.
- [x] Update CLI `--channel` descriptions to include `slack` (already supported by gateway).
- [x] Update UI Cron payload/channel union types to include all supported channels.
- [x] Fix UI CronStatus type to match gateway (`jobs` instead of `jobCount`).
- [x] Update cron UI channel select to include Discord/Slack/Signal/iMessage.
- [x] Update macOS CronJobEditor channel picker + enum to include Slack/Signal/iMessage.
- [x] Document cron compatibility normalization policy in `docs/cron.md`.

### Phase 2 — Input normalization + tooling hardening
- [x] Add shared cron input normalization helpers (`normalizeCronJobCreate`/`normalizeCronJobPatch`).
- [x] Apply normalization in gateway `cron.add` (and patch normalization in `cron.update`).
- [x] Tighten agent cron tool schema to `CronAddParamsSchema` and normalize job/patch before sending.

### Phase 3 — Tests
- [x] Add gateway test covering wrapped `cron.add` payload normalization.
- [x] Add cron tool test to assert normalization and defaulting for `cron.add`.
- [x] Add gateway test covering `cron.update` normalization.
- [x] Add UI + Swift conformance test for cron channels + status fields.

### Phase 4 — Verification
- [x] Run tests (full suite executed via `pnpm test -- cron-tool`).

## Rollout/Monitoring
- Watch gateway logs for reduced `cron.add` INVALID_REQUEST errors.
- Confirm Control UI cron status shows job count after refresh.
- If errors persist, extend normalization for additional common shapes (e.g., `schedule.at`, `payload.message` without `kind`).

## Optional Follow-ups
- Manual Control UI smoke: add cron job per channel + verify status job count.

## Open Questions
- Should `cron.add` accept explicit `state` from clients (currently disallowed by schema)?
- Should we allow `webchat` as an explicit delivery channel (currently filtered in delivery resolution)?
