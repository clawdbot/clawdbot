# Plan — Repair unavailable settled post-tool finalization

## Goal

Close the settled post-tool finalization gap for eligible visible turns when the selected harness does not implement `finalizeSettledTurn`. OpenClaw must persist and deliver exactly one honest deterministic fallback without replaying the original model turn or any completed tool, while preserving failed-tool truth, explicit silent-helper behavior, cancellation, writer fencing, source-suppression metadata, and transcript idempotency.

## Evidence and ownership

- `src/agents/embedded-agent-runner/run/terminal-resolution.ts:121` rejects the request solely because the optional finalizer is absent.
- `src/agents/embedded-agent-runner/run/settled-turn-finalization.ts:108` then returns `not-attempted` before the canonical fallback at `src/agents/embedded-agent-runner/run/settled-turn-finalization.ts:194` and its persistence, projection, and delivery-suppression owners.
- `src/agents/embedded-agent-runner/run/settled-turn-finalization.unavailable.test.ts:106` currently models unavailability with a present callback that throws, so it never proves the missing-capability boundary.
- History to verify before editing: `0ebcfc9bbf`, `6eea20ce18`, and `e1a15aac`; the latter added the canonical fallback while the earlier capability short-circuit remained.
- Direct Codex contract at sibling HEAD `1f7b99922a285f748ef323a53d421fd67ef8438d`: `../codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs:509`, `../codex/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:381`, `../codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:1399`, `../codex/codex-rs/app-server/src/bespoke_event_handling.rs:1128`, `../codex/codex-rs/app-server/src/bespoke_event_handling.rs:1394`, `../codex/codex-rs/app-server/src/bespoke_event_handling.rs:1571`, and `../codex/codex-rs/app-server/src/thread_state.rs:176` prove that completed items and side effects are separate from a turn-completed notification that may contain no final assistant item.
- Existing-solutions gate: the canonical fallback, transcript writer, suppression metadata, and idempotency already exist in the owner module. No dependency, plugin, service, or custom parallel mechanism is warranted.

## Scope

- In:
  - Add a strict regression at the real core boundary with `harness.finalizeSettledTurn` truly undefined after a conclusively settled, potentially side-effecting tool result.
  - Cover successful tool settlement, failed-tool failure honesty, and `silentExpected` behavior.
  - Separate settled-turn eligibility from optional harness capability so missing capability reaches the existing fail-closed fallback owner.
  - Align `docs/plugins/sdk-agent-harness.md:878` with the existing deterministic no-model fallback contract, including the omitted-callback case.
  - Inspect the run-loop caller, terminal resolution, harness selection, built-in/Codex/Copilot siblings, history, tests, and shipped behavior.
- Out:
  - No new configuration, environment variable, protocol, schema, persistence design, dependency, plugin manifest, or public API.
  - No ordinary attempt replay, model retry, tool retry, profile rotation, timeout increase, parallel fallback, or second fallback builder.
  - No changes to Codex, Copilot, or other harness implementations unless new evidence requires a plan revision.
  - No live operator Gateway, operator state, real provider/channel traffic, push, or pull request.

## Success criteria

- Scalar: none; this repair is gates-only.
- Gates:
  - [ ] G0: Snapshot and base are unchanged — eval: verify all three supplied SHA-256 hashes, branch `fix/settled-post-tool-finalization-unavailable`, and merge base `194b7f2a16196481a70c139fb31f1777bdfbdc12`; pause on mismatch.
  - [ ] G1: Strict RED is captured before production edits — eval: add the missing-capability boundary test first, run `node scripts/run-vitest.mjs src/agents/embedded-agent-runner/run/settled-turn-finalization.unavailable.test.ts`, and record a failure caused by the absent fallback rather than setup, dependency, or fixture failure.
  - [ ] G2: Required visible turns get exactly one fallback — eval: the final test proves the finalizer property is undefined, `runAttempt` is never called, the completed tool transcript prefix is byte-for-byte unchanged, the original attempt is unchanged, one non-error fallback payload is returned, one assistant mirror is persisted, and suppression plus `run-settled:settled-finalization-fallback` ownership metadata are present.
  - [ ] G3: Failure and silence remain honest — eval: a settled failed tool retains canonical `failureSignal` and `terminalToolFailure` while receiving the fallback; `silentExpected` receives no synthesized fallback or transcript append; neither case replays model or tool work.
  - [ ] G4: One canonical production flow owns recovery — eval: remove the capability-only request short-circuit or equivalently route absence through the existing owner without adding another fallback branch; reuse the current fallback text builder, transcript persistence, writer fence, source-suppression metadata, and idempotency.
  - [ ] G5: Production delta is net-neutral or negative — eval: classify `git diff --numstat 194b7f2a16196481a70c139fb31f1777bdfbdc12...HEAD`; reject avoidable positive production growth and separately classify tests, docs, and planner artifacts.
  - [ ] G6: Documentation states the observed contract — eval: after dependencies are available, run `pnpm docs:list`, update only the settled-finalization section, and pass `pnpm check:docs`.
  - [ ] G7: Focused owner and sibling tests pass — eval: run the unavailable, settled-finalization, terminal-resolution, built-in harness, harness selection/result, Codex finalizer, and Copilot harness tests through `scripts/run-vitest.mjs`.
  - [ ] G8: Repository gates pass — eval: `pnpm changed:lanes`, `pnpm check:changed`, `pnpm check`, `pnpm check:test-types`, `pnpm build`, `pnpm test`, `pnpm check:docs`, and `git diff --check` all succeed; one documented full-suite flake rerun is allowed by repository policy.
  - [ ] G9: Independent review is clean at exact HEAD — eval: Reviewer records the reviewed SHA, remains read-only, checks current and shipped behavior, direct Codex sources, caller/callee and sibling paths, test value, docs, and production-versus-test LOC, with no unresolved P0/P1 or doctrine finding.

## Constraints

- Allowed implementation files: `src/agents/embedded-agent-runner/run/terminal-resolution.ts` and `src/agents/embedded-agent-runner/run/settled-turn-finalization.ts`.
- Allowed regression files: `src/agents/embedded-agent-runner/run/settled-turn-finalization.test.ts` and `src/agents/embedded-agent-runner/run/settled-turn-finalization.unavailable.test.ts`.
- Allowed documentation file: `docs/plugins/sdk-agent-harness.md`.
- Planner-owned `plan.md` and `goal.json` are read-only to Coder and Reviewer.
- Preserve and never stage, edit, or delete the existing untracked `tasks/` material.
- The planner shell currently lacks `pnpm` and dependencies. Provision the repository-pinned pnpm 12.1.0 through the supported toolchain, run `pnpm install`, retry once if needed, and report the first actionable failure without changing package or lock files.
- Never edit source or tests while a Vitest process is running.
- Use only temporary session fixtures and isolated mock/dev boundaries; never touch operator Gateway or state.
- Do not push or create a PR; the root owner publishes after independent verification.

## Approach (Coder hint)

Make settled-turn request resolution answer only whether the completed turn is eligible for terminal recovery, not whether an optional callback exists. Prefer deleting the stale availability parameter and short-circuit so the existing fail-closed harness operation and its single canonical fallback path own absence exactly as they own a thrown finalizer failure. Write and run the true-undefined regression before production edits, then keep the production diff net-negative.

## Reviewer rubric (extra)

Reject a RED caused by missing tooling, malformed fixtures, or changed expectations unrelated to the missing fallback. Reject tests that leave a throwing `finalizeSettledTurn` installed, mock away real transcript persistence, mutate the original attempt, or infer no replay without asserting both absent finalizer and zero `runAttempt` calls. Reject consumer-only guards, duplicated fallback text/persistence, new retry policy, weakened cancellation or writer fencing, hidden config, stale docs, or positive production LOC without an irreducible owner-boundary reason. Reviewer must personally inspect the cited Codex files at the actual sibling SHA and the exact OpenClaw HEAD only after all pre-review gates are green.

## Termination

Stop after six Coder/Reviewer iterations, earlier on all gates passing, or on a genuine blocker after the required dependency retry and safe in-scope alternatives are exhausted.