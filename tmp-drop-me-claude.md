# Drift-cure decision journal

## 2026-08-29 - Section 0: dispatch baseline and named refs

This lane is bound to openclaw/openclaw#129388. The accepted candidate was
published unchanged before evidence. The protected presentation branch is
read-only and is not named or updated by this lane.

| Ref role              | Named ref                                                    | Full SHA                                   | Identity receipt                                                                                         |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Product/base          | `codeagent/129388-terminal-notice-test-import-fix-20260829`  | `a214b8d040aee5eb639d1753580d8abeba716593` | local = tracking = server; tree `ef9ee3995db7c64b865355003885c3d60602ec7f`                               |
| Pinned upstream floor | `openclaw/openclaw@43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5` | `43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5` | local object resolved; merge base `93f7152b098beeb9ac64cb9b2437fc45a7558adf`                             |
| Safe lane             | `codeagent/129388-a214-upstream-43a7-gates-absorb-20260829`  | `a214b8d040aee5eb639d1753580d8abeba716593` | local = tracking = server before this journal commit                                                     |
| CI/workflow           | `karmaterminal/openclaw-bootstrap:main`                      | `e768ccc2e1e0887be455e6880db0bff91a1dfddd` | server = pinned tooling checkout                                                                         |
| Presentation          | N/A                                                          | `00c7f721a55554d0b9228337cc8bc6bec88f9e9f` | read-only commit anchor supplied by workorder; intentionally not resolved to or updated through a branch |
| Docs/proof            | N/A                                                          | `16f8bca6593813adb25e864c91d38f456b1708c0` | accepted proof-harness commit anchor supplied by workorder; execution explicitly out of scope            |

The accepted candidate savegame
`savegame/129388-terminal-notice-test-import-fix-a214b8d0-20260829` also
resolved local = tracking = server at `a214b8d040aee5eb639d1753580d8abeba716593`.
Later upstream motion was recorded as context only
(`upstream/main` `cf873021404d4d5872b970622142387876d497ac`);
the fixed floor remains `43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5`.

Pinned GATES authority:

| Tool                                        | Blob SHA                                   | Owning commit                              |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `RUNBOOKS/PR-DRIFT-CURE-GATES-RUNBOOK.md`   | `e42d5eedbf52cb1d0fa307749b83c8625899c26e` | `a8ee8cd4a88e172d20894a98c26f5b2804700fec` |
| `tools/drift-cure-gate.sh`                  | `90e4caddbe9f40248510d376bc00558ec75bcdcb` | `79a954f624f3b7f9ac32a3ddbc689b9e67329a4c` |
| `tools/feature-cores-byte-check.sh`         | `4e86ba83621cec98573c5173d91e426f72e1d321` | `6a0bdf6b33b3351b3a0b837c66d2a8030e48a36b` |
| `tools/drift-cure-gate.primitive-cores.txt` | `8e475b7a1a2bf14a0dda4640bd221fff867f4c1b` | `97c8d6a9b7b8117664ce4399a7170751534708c4` |
| `.github/workflows/openclaw-local-ci.yml`   | `8d9d16d7b6e6c3fb581d7a102003f8c59bee8dc3` | `e768ccc2e1e0887be455e6880db0bff91a1dfddd` |

Dispatch-time Gate 2.7 examined all 959 reviewer-visible paths against the
fixed upstream floor: 0 FROZEN-STALE, 190 MIXED-CLOBBER, 454 GENUINE, and
315 SAFE-NEW. The MIXED rows carry 5,477 ranked dropped-line observations and
are a post-merge disposition queue, not an automatic defect verdict.

Gate 2.5 enumerated 1,483 upstream-touched test/support paths between
`93f7152b098beeb9ac64cb9b2437fc45a7558adf` and the pinned floor; 68 intersect
the accepted candidate surface. The canonical primitive-core inventory has 40
entries: 37 resolved paths and 3 absent tombstones, with no unresolved
non-tombstone pattern. The current runbook explicitly retires the unmerged
`feature-audit.sh`; whole-file feature preservation is owned by this canonical
primitive-core inventory, so no substitute script was invented.

Read-only `git merge-tree` predicted 44 textual conflicts across 194
upstream/feature-overlap paths. Independent three-way analysis exposed a schema
v19 composition question: candidate v19 adds recipient-authority convergence,
while upstream v19 adds creator-namespace migration. Direct owner inspection
showed both parents already declare v19 and the v18-to-v19 transaction can run
both disjoint migrations before the single version stamp. The merge will keep
v19 and compose both existing parent contracts; it will not invent an
unapproved v20 surface. Required proof is a deterministic v18 fixture carrying
both legacy shapes, restart/idempotency coverage, and exact parent comparison.

## 2026-08-29 - Sections 1 and 2: exact back-merge and cure decisions

The exact back-merge commit is
`3b854dd1862cae7208f3e031a0a08d276cd8626e`, tree
`8e8109258231a293847733faf0f3f75d54c58449`, with ordered parents
`9de8dd7fcfb34fa1769ff0bfac3790818dc44a15` and
`43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5`. It is a normal merge commit;
the accepted candidate remains on its first-parent lineage and the exact pinned
upstream floor is its second parent.

Complete textual-conflict decision ledger:

| Conflict path                                                                                             | Decision                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docs/reference/database-schemas.md`                                                                      | Keep upstream state v14/v15 and document both already-approved agent-v19 migrations.                              |
| `package.json`                                                                                            | Keep upstream state schema 15 and composed agent schema 19; no new version bump.                                  |
| `scripts/plugin-sdk-surface-report.mts`                                                                   | Union parent rationale, then recompute exact merged budgets.                                                      |
| `scripts/prepare-extension-package-boundary-artifacts.mts`                                                | Take upstream content-hash refactor; it supersedes the candidate mtime workaround.                                |
| `src/agents/agent-hooks/compaction-safeguard.ts`                                                          | Use upstream safeguard/model-usage rewrite plus candidate Copilot IDE auth headers.                               |
| `src/agents/agent-tools.ts`                                                                               | Preserve both `sandboxWritable` and upstream media-read capability.                                               |
| `src/agents/embedded-agent-runner/compact-reasons.test.ts`                                                | Initially unioned tests; Gate 2 later required the exact accepted blob.                                           |
| `src/agents/embedded-agent-runner/compact.abort-signal.test.ts`                                           | Keep candidate isolated-state harness plus upstream agent-DB close.                                               |
| `src/agents/embedded-agent-runner/compact.hooks.test.ts`                                                  | Initially unioned nonduplicate tests; Gate 2 later required the exact accepted blob.                              |
| `src/agents/embedded-agent-subscribe.ts`                                                                  | Keep candidate lifecycle extraction plus upstream session model-usage sink and cleanup.                           |
| `src/agents/openclaw-tools.types.ts`                                                                      | Preserve both sandbox capability fields and continuation options.                                                 |
| `src/agents/subagents/spawn/subagent-spawn-contract.ts`                                                   | Compose upstream discriminated context with candidate cancelled admission and rollback shape.                     |
| `src/agents/subagents/spawn/subagent-spawn.test-helpers.ts`                                               | Union every registry mock binding used by either parent.                                                          |
| `src/agents/subagents/spawn/subagent-spawn.test.ts`                                                       | Preserve continuation coverage and adopt upstream isolation-subject/creator provenance.                           |
| `src/agents/subagents/spawn/subagent-spawn.ts`                                                            | Keep candidate admission flow; add upstream child-entry ownership, context result, resolver, and prompt contract. |
| `src/auto-reply/get-reply-options.types.ts`                                                               | Union continuation trigger with upstream reply-dispatch transcript/run types.                                     |
| `src/auto-reply/reply/agent-runner-embedded-candidate.ts`                                                 | Union continuation/compaction options with upstream reply-dispatch transcript hooks.                              |
| `src/auto-reply/reply/agent-runner-execute.ts`                                                            | Preserve both continuation controller and visible-reply resolver.                                                 |
| `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`                                             | Preserve real registration/retirement via candidate import spread and upstream intent.                            |
| `src/auto-reply/reply/commands-system-prompt.ts`                                                          | Keep used continuation inventory helper; adopt upstream runtime prompt resolver and remove dead import.           |
| `src/auto-reply/reply/get-reply.fast-path.test.ts`                                                        | Use candidate isolated session-store helper consistently.                                                         |
| `src/auto-reply/reply/session-system-events.ts`                                                           | Union delivery queue ownership with upstream heartbeat awareness.                                                 |
| `src/auto-reply/reply/session.test.ts`                                                                    | Union continuation stores with upstream command/directive coverage.                                               |
| `src/cli/update-cli/update-command-post-update.test.ts`                                                   | Take upstream managed service identity fixture, which subsumes the candidate HOME fix.                            |
| `src/config/sessions/session-accessor.sqlite-entry.ts`                                                    | Adopt upstream lifecycle snapshot refactor and retain candidate same-transaction authority hook.                  |
| `src/gateway/server-chat.agent-events.test.ts`                                                            | Preserve candidate terminal-owner coverage and upstream chat-error coverage.                                      |
| `src/gateway/server-chat.ts`                                                                              | Compose candidate terminal-sequence ownership with upstream reply-dispatch persistence claim cleanup.             |
| `src/gateway/server-maintenance.ts`                                                                       | Adopt upstream owner-policy API and retain candidate delegate-artifact purge.                                     |
| `src/gateway/server-methods/chat-send-agent-dispatch.ts`                                                  | Use candidate finalization owner with upstream reply-dispatch, terminal classification, and rich dedupe inputs.   |
| `src/gateway/server-methods/chat-send-dispatch-errors.ts`                                                 | Preserve both terminal-broadcast marker and reply-dispatch predicate.                                             |
| `src/gateway/server-methods/chat-send-reply-finalization.ts`                                              | Adopt upstream rename/runtime terminal projection and reapply candidate terminal marker.                          |
| `src/gateway/server-methods/chat-send-source-finalization.ts`                                             | Apply terminal marker only with the upstream non-suppressed final broadcast.                                      |
| `src/gateway/server-runtime-subscriptions.ts`                                                             | Compose candidate tracked-run cleanup with upstream persistence preparation and synchronous live-authority guard. |
| `src/state/openclaw-agent-db-contract.ts`                                                                 | Keep schema 19 and describe both participant/recipient and creator-namespace concerns.                            |
| `src/state/openclaw-agent-db-schema-helpers.ts`                                                           | Keep generic migration repair diagnostic.                                                                         |
| `src/state/openclaw-agent-db-schema.ts`                                                                   | Run participant convergence, creator migration, schema install, and recipient migration before one v19 stamp.     |
| `src/state/openclaw-agent-db-session-migrations.ts`                                                       | Preserve recipient migration and upstream transcript-eligibility/creator migrations.                              |
| `src/state/openclaw-agent-participants-migration.test.ts`                                                 | Keep symbolic current-version assertions.                                                                         |
| `src/tasks/task-flow-registry.audit.test.ts`                                                              | Combine candidate reset lifecycle with upstream nonpersistent resets.                                             |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md.diff` | Regenerate from the merged prompt owner.                                                                          |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md`    | Regenerate from the merged prompt owner.                                                                          |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-heartbeat-codex-tool.md.diff`    | Regenerate from the merged prompt owner.                                                                          |
| `test/scripts/install-sh.test.ts`                                                                         | Preserve both parent test additions with one local variable spelling.                                             |
| `test/scripts/telegram-mantis-sut.test.ts`                                                                | Delete with upstream because the owning Mantis SUT was removed.                                                   |

Gate 2 first rejected `3b854dd1862cae7208f3e031a0a08d276cd8626e`
because the two hand-merged compaction test cores were neither accepted blobs
nor exact upstream projections. Successor
`c842f07c267d98ca2c3edb6c29eedfaf2be32a52` restores those two exact accepted
blobs. The rerun reports 40 invariants, 0 failures, 5 exact upstream
projections, and 3 tombstones.

Gate 2.7 on the successor uses the exact pinned second parent as its base and
examines 956 reviewer-visible paths: 0 FROZEN-STALE, 0 MIXED-CLOBBER,
642 GENUINE, and 314 SAFE-NEW. This discharges every material pre-merge MIXED
row because the final branch is now a direct overlay on the pinned upstream
tree; no dropped post-floor content remains in the classifier.

The schema conflict also received a deterministic owner-boundary negative
control. At rejected merge `3b854dd1862`, the existing
`openclaw-agent-participants-migration.test.ts` fails the covenant physical-v18
lineage with noncanonical participant columns/indexes. Restoring unconditional,
structure-gated participant convergence makes all 18 cases pass in the current
worktree, including covenant-v18, upstream-v18, maintenance refusal, rollback,
restart, foreign-key check, and integrity check. Both SHAs share the exact
`pnpm-lock.yaml` blob `1edc779c3467d2f30837b1ae09208fc223fca85c`.

Generated surfaces were regenerated from the merged owners. Prompt snapshot
check reports all 7 files current. Plugin SDK surface reports 148 public
entrypoints, 4,374 exports, 2,598 callable exports, 1,141 deprecated exports,
50 wildcard reexports, and zero forbidden package subpaths.

## 2026-08-31 - Section 0A: bounded absorb named refs and tool identities

This cycle is bound to openclaw/openclaw#129388 and freezes upstream at exact
`8e32494fcf839181a5f02a1f0649068cd91d2b14`. Later upstream motion is context
only. The safe lane was published unchanged at the accepted candidate before
this evidence commit.

| Ref role | Named ref | Full SHA | Identity receipt |
| --- | --- | --- | --- |
| Product/base | `codeagent/129388-semantic-tree-valid-trailer-reemit-20260830` | `0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` | local object = `origin/` tracking = server; tree `52b6141c80e575813f94241635ce02007b50d140` |
| Pinned upstream floor | `openclaw/openclaw@8e32494fcf839181a5f02a1f0649068cd91d2b14` | `8e32494fcf839181a5f02a1f0649068cd91d2b14` | local object = GitHub server commit; tree `466a6dc233262280d5586c3126d1b7fb81c347b5`; tracking N/A for immutable commit |
| Merge base | `openclaw/openclaw@43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5` | `43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5` | local object = GitHub server commit; tree `7f2ff579be8b954e4becdd10b6388ae79afc09ab`; tracking N/A for immutable commit |
| Safe lane | `codeagent/129388-0ed59cb6-upstream-8e32494f-gates-absorb-20260831` | `0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` | local = `origin/` tracking = server before this journal commit |
| Accepted savegame | `savegame/129388-semantic-tree-valid-trailer-reemit-0ed59cb6-20260830T1615Z` | `0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` | local `origin/` tracking = server; immutable rollback/loss-traversal anchor |
| CI/workflow | `karmaterminal/openclaw-bootstrap:codeagent/129388-primitive-core-semantic-test-routing-cure-20260830` | `3c5acdb72e94755f469fc6cc3276d5b8623d5b49` | bootstrap `origin/` tracking = server; tree `0d3fd64e035e1f812bb8a5c6d8770a848ff23da6` |
| Presentation | `karmaterminal/openclaw:codeagent/85651-upstream-1ba243c8-gates` | `00c7f721a55554d0b9228337cc8bc6bec88f9e9f` | local object = `origin/` tracking = server; read-only, no presentation operation authorized |
| Docs/proof corpus | `karmaterminal/karmaterminal-openclaw-docs:codeagent/129388-0ed59cb6-full-exact-proof-20260830` | `ba8d344c1240275a9c54042294b8129eea4e497b` | fetched local object = server branch; tree `ef41579bd847b4da2719b99a229ac66624493bb5`; read-only |
| Reviewed harness implementation | `karmaterminal/karmaterminal-openclaw-docs:savegame/129388-harness-sql-comment-tokenizer-cure-15e47942-20260830T223855Z` | `15e479424518b4831c95511873f5c6b81ad52a79` | fetched local object = server savegame; tree `5b1ccbaed5f5bebb28459680db1c61cd6414a0cb`; read-only |
| Reviewed harness report | `karmaterminal/karmaterminal-openclaw-docs:codeagent/129388-harness-sql-comment-tokenizer-cure-20260830` | `1f272dbef90048fa08df5a454bf63c224e3a9313` | fetched local object = server branch; tree `3d5953752a36ca8099efb10297601cf5929613f2`; read-only |
| Independent harness review | `karmaterminal/karmaterminal-openclaw-docs:codeagent/129388-15e47942-tokenizer-independent-review-20260830` | `192a1814cf4150fc07496c1164fbcff6c3fe9e54` | fetched local object = server branch; tree `8ffbfda579cd2577c3f389ed452a60a4e30df30a`; read-only |
| Components / docs main / fleet | N/A | N/A | Explicitly read-only and not an evidence or mutation target for this bounded lane |

Pinned GATES and runtime identities:

| Tool or contract | Exact identity | Receipt |
| --- | --- | --- |
| `RUNBOOKS/PR-DRIFT-CURE-GATES-RUNBOOK.md` | blob `e42d5eedbf52cb1d0fa307749b83c8625899c26e` | identical on bootstrap `main@e768ccc2e1e0887be455e6880db0bff91a1dfddd` and reviewed workflow SHA |
| `tools/drift-cure-gate.sh` | blob `90e4caddbe9f40248510d376bc00558ec75bcdcb` | identical on bootstrap main and reviewed workflow SHA |
| `tools/feature-cores-byte-check.sh` | blob `4e86ba83621cec98573c5173d91e426f72e1d321` | identical on bootstrap main and reviewed workflow SHA |
| `tools/drift-cure-gate.primitive-cores.txt` | blob `78b89718ca8c2cb18c3f085678c7246049cd69d6` | reviewed workflow branch; 35 explicit paths plus 3 tombstones |
| `tests/test-drift-cure-primitive-semantic-tests.sh` | blob `0afa2e9b8363eaa70fae25fe2d1fde0cdf174b1a` | reviewed workflow branch |
| `.github/workflows/openclaw-local-ci.yml` | blob `8d9d16d7b6e6c3fb581d7a102003f8c59bee8dc3` | identical on bootstrap main and reviewed workflow SHA |
| `scripts/prepush-ci.sh` | blob `766533b6c57409f939ace2b193c6ddab6b5bd720` | accepted product candidate; fallback not authorized for this cycle |
| `scripts/run-vitest.mjs` | blob `f71cb1c62b4272abac1c7059cb925e4afdbacc97` | accepted product candidate |
| Node | `/home/figs/.nvm/versions/node/v24.17.0/bin/node`, `v24.17.0` | local executable version receipt |
| Corepack | `/home/figs/.nvm/versions/node/v24.17.0/bin/corepack`, `0.35.0` | local executable version receipt |
| pnpm | `12.0.0` via the pinned package-manager contract | lane-local Corepack cache under session state; inherited `~/.local/bin/pnpm` rejected as a stale Actions-cache link |

### Dispatch-time Gate 2.7 and merge envelope

The required comparison was recomputed against the immutable pair
`0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` and
`8e32494fcf839181a5f02a1f0649068cd91d2b14`, not moving upstream:

| Measurement | Result |
| --- | --- |
| Reviewer-visible feature paths (`8e32494f...0ed59cb6`) | 956 |
| Candidate paths changed since merge base `43a7cb3c` | 956 |
| Upstream paths changed since merge base `43a7cb3c` | 4,139 |
| Paths changed on both sides | 245 |
| `git merge-tree --write-tree --name-only` textual conflicts | 69 |
| Read-only virtual merge tree | `9220fadb7c9c4e0fa49dedeccc74a739e857b92c` |

This exactly matches the workorder's `956 / 245 / 69` dispatch envelope.

Pre-merge Gate 2.7 examined all 956 feature-visible paths with merge base
`43a7cb3c` as the ranking baseline: 0 FROZEN-STALE, 236 MIXED-CLOBBER
(7,114 ranked dropped-line observations), 405 GENUINE, and 315 SAFE-NEW.
The frozen count remains zero, so no stacking-complexity pause is required.
The mixed rows are the explicit upstream-drift queue the back-merge must absorb,
not post-merge dispositions.

Gate 2.5 enumerated 1,781 upstream-touched test/support paths from `43a7cb3c`
through `8e32494f`; 96 intersect the accepted feature surface and 94 are in
the both-sides overlap. The reviewed primitive inventory resolves 35 present
paths and 3 absent tombstones with no missing live path. The baseline feature
inventory also identifies 29 generated/protocol/plugin-SDK/snapshot surfaces.
Proof-sensitive path counts are overlapping owner signals, not additive:
181 continuation, 61 compaction, 13 tool-event/tool-call, 129
registry/subagent, 6 return-covenant, 31 queue, 146 session/transcript, 27
restart/recovery, 78 gateway, 6 Telegram, and 21 schema/migration paths.
