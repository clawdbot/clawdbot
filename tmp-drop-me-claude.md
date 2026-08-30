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
