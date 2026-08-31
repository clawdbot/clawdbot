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

| Ref role                        | Named ref                                                                                                                | Full SHA                                   | Identity receipt                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Product/base                    | `codeagent/129388-semantic-tree-valid-trailer-reemit-20260830`                                                           | `0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` | local object = `origin/` tracking = server; tree `52b6141c80e575813f94241635ce02007b50d140`                             |
| Pinned upstream floor           | `openclaw/openclaw@8e32494fcf839181a5f02a1f0649068cd91d2b14`                                                             | `8e32494fcf839181a5f02a1f0649068cd91d2b14` | local object = GitHub server commit; tree `466a6dc233262280d5586c3126d1b7fb81c347b5`; tracking N/A for immutable commit |
| Merge base                      | `openclaw/openclaw@43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5`                                                             | `43a7cb3c92c7b5b8d5ddd56d9d157c009e0c85e5` | local object = GitHub server commit; tree `7f2ff579be8b954e4becdd10b6388ae79afc09ab`; tracking N/A for immutable commit |
| Safe lane                       | `codeagent/129388-0ed59cb6-upstream-8e32494f-gates-absorb-20260831`                                                      | `0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` | local = `origin/` tracking = server before this journal commit                                                          |
| Accepted savegame               | `savegame/129388-semantic-tree-valid-trailer-reemit-0ed59cb6-20260830T1615Z`                                             | `0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` | local `origin/` tracking = server; immutable rollback/loss-traversal anchor                                             |
| CI/workflow                     | `karmaterminal/openclaw-bootstrap:codeagent/129388-primitive-core-semantic-test-routing-cure-20260830`                   | `3c5acdb72e94755f469fc6cc3276d5b8623d5b49` | bootstrap `origin/` tracking = server; tree `0d3fd64e035e1f812bb8a5c6d8770a848ff23da6`                                  |
| CI/workflow successor           | `karmaterminal/openclaw-bootstrap:codeagent/129388-primitive-core-routing-gap-cure-20260831`                             | `38a833154cba6a9d562302799bff27941aa39dd3` | local = `origin/` tracking = server; tree `91674b4f43ff18454db3c035e5032cf7bce0894d`; exact Gate 2 routing cure         |
| Presentation                    | `karmaterminal/openclaw:codeagent/85651-upstream-1ba243c8-gates`                                                         | `00c7f721a55554d0b9228337cc8bc6bec88f9e9f` | local object = `origin/` tracking = server; read-only, no presentation operation authorized                             |
| Docs/proof corpus               | `karmaterminal/karmaterminal-openclaw-docs:codeagent/129388-0ed59cb6-full-exact-proof-20260830`                          | `ba8d344c1240275a9c54042294b8129eea4e497b` | fetched local object = server branch; tree `ef41579bd847b4da2719b99a229ac66624493bb5`; read-only                        |
| Reviewed harness implementation | `karmaterminal/karmaterminal-openclaw-docs:savegame/129388-harness-sql-comment-tokenizer-cure-15e47942-20260830T223855Z` | `15e479424518b4831c95511873f5c6b81ad52a79` | fetched local object = server savegame; tree `5b1ccbaed5f5bebb28459680db1c61cd6414a0cb`; read-only                      |
| Reviewed harness report         | `karmaterminal/karmaterminal-openclaw-docs:codeagent/129388-harness-sql-comment-tokenizer-cure-20260830`                 | `1f272dbef90048fa08df5a454bf63c224e3a9313` | fetched local object = server branch; tree `3d5953752a36ca8099efb10297601cf5929613f2`; read-only                        |
| Independent harness review      | `karmaterminal/karmaterminal-openclaw-docs:codeagent/129388-15e47942-tokenizer-independent-review-20260830`              | `192a1814cf4150fc07496c1164fbcff6c3fe9e54` | fetched local object = server branch; tree `8ffbfda579cd2577c3f389ed452a60a4e30df30a`; read-only                        |
| Components / docs main / fleet  | N/A                                                                                                                      | N/A                                        | Explicitly read-only and not an evidence or mutation target for this bounded lane                                       |

Pinned GATES and runtime identities:

| Tool or contract                                    | Exact identity                                                  | Receipt                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `RUNBOOKS/PR-DRIFT-CURE-GATES-RUNBOOK.md`           | blob `e42d5eedbf52cb1d0fa307749b83c8625899c26e`                 | identical on bootstrap `main@e768ccc2e1e0887be455e6880db0bff91a1dfddd` and reviewed workflow SHA                    |
| `tools/drift-cure-gate.sh`                          | blob `90e4caddbe9f40248510d376bc00558ec75bcdcb`                 | identical on bootstrap main and reviewed workflow SHA                                                               |
| `tools/feature-cores-byte-check.sh`                 | blob `4e86ba83621cec98573c5173d91e426f72e1d321`                 | identical on bootstrap main and reviewed workflow SHA                                                               |
| `tools/drift-cure-gate.primitive-cores.txt`         | blob `78b89718ca8c2cb18c3f085678c7246049cd69d6`                 | reviewed workflow branch; 35 explicit paths plus 3 tombstones                                                       |
| `tests/test-drift-cure-primitive-semantic-tests.sh` | blob `0afa2e9b8363eaa70fae25fe2d1fde0cdf174b1a`                 | reviewed workflow branch                                                                                            |
| Gate 2 successor runbook                            | blob `c1f55f1fd2784b2823f36780ea2e86607e61f67c`                 | bootstrap successor `38a833154cba6a9d562302799bff27941aa39dd3`                                                      |
| Gate 2 successor primitive inventory                | blob `387ff9ce4e9f3160468a1dfa0eb98e7feddcc976`                 | 33 live paths plus three tombstones; mutable runner test/support rows removed                                       |
| Gate 2 successor semantic-routing regression        | blob `f1d49236f11124597dee15628192adb7bd56fc4d`                 | four shared test/support surfaces, rejected-inventory negative control, production-primitive negative control       |
| `.github/workflows/openclaw-local-ci.yml`           | blob `8d9d16d7b6e6c3fb581d7a102003f8c59bee8dc3`                 | identical on bootstrap main and reviewed workflow SHA                                                               |
| `scripts/prepush-ci.sh`                             | blob `766533b6c57409f939ace2b193c6ddab6b5bd720`                 | accepted product candidate; fallback not authorized for this cycle                                                  |
| `scripts/run-vitest.mjs`                            | blob `f71cb1c62b4272abac1c7059cb925e4afdbacc97`                 | accepted product candidate                                                                                          |
| Node                                                | `/home/figs/.nvm/versions/node/v24.17.0/bin/node`, `v24.17.0`   | local executable version receipt                                                                                    |
| Corepack                                            | `/home/figs/.nvm/versions/node/v24.17.0/bin/corepack`, `0.35.0` | local executable version receipt                                                                                    |
| pnpm                                                | `12.1.0` via the merged package-manager contract                | lane-local Corepack cache under session state; inherited `~/.local/bin/pnpm` rejected as a stale Actions-cache link |

### Dispatch-time Gate 2.7 and merge envelope

The required comparison was recomputed against the immutable pair
`0ed59cb64f31971e8659b417fe3fd2ba6a1730c3` and
`8e32494fcf839181a5f02a1f0649068cd91d2b14`, not moving upstream:

| Measurement                                                 | Result                                     |
| ----------------------------------------------------------- | ------------------------------------------ |
| Reviewer-visible feature paths (`8e32494f...0ed59cb6`)      | 956                                        |
| Candidate paths changed since merge base `43a7cb3c`         | 956                                        |
| Upstream paths changed since merge base `43a7cb3c`          | 4,139                                      |
| Paths changed on both sides                                 | 245                                        |
| `git merge-tree --write-tree --name-only` textual conflicts | 69                                         |
| Read-only virtual merge tree                                | `9220fadb7c9c4e0fa49dedeccc74a739e857b92c` |

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

## 2026-08-31 - Sections 1-4: bounded merge and semantic closure

The exact normal merge is
`06f02c9b06717426df9ab88948c7b4d226443df8`, tree
`742c357fc03f63b8c43961150e15413f47f22555`, with ordered parents
`131b5b12f032b30ffb56ba836bb437151f1fda85` and
`8e32494fcf839181a5f02a1f0649068cd91d2b14`. The accepted candidate remains
on the first-parent lineage and the frozen upstream floor is the exact second
parent. No rebase, squash, reset, amend, force push, or presentation write
occurred.

### Complete 69-row textual-conflict ledger

The merge index recorded 69 unique paths: 68 content conflicts and one
modify/delete conflict. Decisions below were rechecked against both stages,
the merge base, post-merge repair commits, and the named focused owner
receipts.

|   # | Path                                                                                                      | Decision    | Semantic reason                                                                                                                                          | Proof                                                               |
| --: | --------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
|   1 | `config/assertion-safety-baseline.txt`                                                                    | Composed    | Start from upstream debt, then prune only assertions removed by concrete-owner typing.                                                                   | Assertion ratchet: 4,152 files / 12,824 assertions.                 |
|   2 | `extensions/telegram/src/bot.create-telegram-bot.test.ts`                                                 | Composed    | Keep distinct group activation state and add upstream retry-store isolation/current model policy.                                                        | Telegram conflict owners: 157/157.                                  |
|   3 | `scripts/plugin-sdk-surface-report.mts`                                                                   | Composed    | Retain continuation exports, remove retired conversation-binding exports, and recompute real budgets.                                                    | SDK surface: 147 public entrypoints / 4,370 exports / 0 forbidden.  |
|   4 | `scripts/protocol-gen.ts`                                                                                 | Composed    | Use upstream document construction/writer while retaining internal-field publication filtering.                                                          | Protocol registry/generation/since checks green.                    |
|   5 | `src/agents/agent-tools.before-tool-call.wrapper.ts`                                                      | Composed    | Preserve trace/replay lifecycle; adopt canonical plugin/channel metadata and pre-action abort recheck.                                                   | Attempt-client and tool-identity owners: 15/15.                     |
|   6 | `src/agents/agent-tools.ts`                                                                               | Composed    | Keep continuation controls and sandbox write state; add staged media, bound caller identity, placement transport, and identity wrapping.                 | Embedded run owners: 122/122.                                       |
|   7 | `src/agents/embedded-agent-runner/compact.hooks.test.ts`                                                  | Composed    | Combine continuation pressure coverage with upstream durable compaction/usage cases in the authoritative store.                                          | Compact hooks: 168/168.                                             |
|   8 | `src/agents/embedded-agent-runner/run.overflow-compaction.harness.ts`                                     | Composed    | Combine continuation/auth controls with state-backed workspaces, current internal params, synchronous truncation, admission, and concrete tool identity. | Continuation integration: 53/53; Gate 2 routing gap recorded below. |
|   9 | `src/agents/embedded-agent-runner/run/attempt-client-tools.ts`                                            | Composed    | Preserve replay sets while adopting canonical concrete-object metadata and abort-bound construction.                                                     | Attempt-client/tool identity: 15/15.                                |
|  10 | `src/agents/embedded-agent-runner/run/attempt-tool-prepare.ts`                                            | Composed    | Retain continuation tools and absorb staged media, abort propagation, replay metadata, and current sandbox preparation.                                  | Embedded run owners: 122/122.                                       |
|  11 | `src/agents/embedded-agent-runner/run/overflow-context-recovery.ts`                                       | Composed    | Keep pressure/parked-work behavior; adopt closure-bound authority, session-manager truncation, and canonical adoption.                                   | Overflow shard: 23/23.                                              |
|  12 | `src/agents/embedded-agent-runner/run/payloads.ts`                                                        | Composed    | Preserve item boundaries for multi-item continuation markers while using prepared directives for single-item answers.                                    | Payload owners: 56/56.                                              |
|  13 | `src/agents/embedded-agent-runner/run/timeout-context-recovery.ts`                                        | Composed    | Keep pressure guidance; adopt current compaction runtime, live-authority rechecks, and guarded retry preparation.                                        | Embedded run owners: 122/122.                                       |
|  14 | `src/agents/embedded-agent-subscribe.handlers.compaction.test.ts`                                         | Composed    | Fold candidate attribution into upstream durable-writer/detached-run cases instead of keeping duplicate tests.                                           | Subscriber owners: 384/384.                                         |
|  15 | `src/agents/embedded-agent-subscribe.handlers.compaction.ts`                                              | Composed    | Emit trigger/count facts while respecting `compactionCountOwner`, detached no-write behavior, and one durable record.                                    | Subscriber owners: 384/384.                                         |
|  16 | `src/agents/embedded-agent-subscribe.handlers.messages.lifecycle.ts`                                      | Composed    | Preserve validation/commentary rules and adopt lazy raw-stream, usage, and final-phase ownership.                                                        | Commentary owners: 56/56.                                           |
|  17 | `src/agents/embedded-agent-subscribe.handlers.messages.stream.ts`                                         | Composed    | Preserve continuation display filtering; adopt upstream stream projection and delete the duplicate commentary emitter.                                   | Commentary owners: 56/56.                                           |
|  18 | `src/agents/embedded-agent-subscribe.handlers.messages.update.ts`                                         | Composed    | Keep provider-aware commentary/continuation filtering with upstream normalized lazy stream writes.                                                       | Subscriber owners: 384/384.                                         |
|  19 | `src/agents/embedded-agent-subscribe.handlers.tools.completion.ts`                                        | Composed    | Preserve delivery-generation/effect fencing and after-hooks while retaining current terminal/reconciliation data.                                        | Tool owners: 216/216.                                               |
|  20 | `src/agents/embedded-agent-subscribe.handlers.tools.start.ts`                                             | Composed    | Preserve stale-generation fencing; adopt async question readiness and secret binding; centralize activity mirroring.                                     | Tool owners: 216/216.                                               |
|  21 | `src/agents/embedded-agent-subscribe.handlers.ts`                                                         | Composed    | Keep attempt generations and compaction invalidation; capture upstream usage before transcript repair.                                                   | Subscriber owners: 384/384.                                         |
|  22 | `src/agents/embedded-agent-subscribe.stream-rendering.ts`                                                 | Composed    | Preserve retryable ordered settlement and upstream normalized-text dedupe.                                                                               | Subscriber owners: 384/384.                                         |
|  23 | `src/agents/embedded-agent-subscribe.ts`                                                                  | Composed    | Keep extracted lifecycle/tool owners and retain upstream model-usage sink, token owner, and cleanup.                                                     | Subscriber owners: 384/384.                                         |
|  24 | `src/agents/embedded-agent-utils.ts`                                                                      | Composed    | Strip continuation only from display text while preserving phase/item-aware final extraction.                                                            | Payload/subscriber owners: 56/56 and 384/384.                       |
|  25 | `src/agents/openclaw-tools.sessions.test.ts`                                                              | Composed    | Retain continuation/session authority cases and upstream linked cross-session presentation coverage.                                                     | Effective inventory owners: 24/24.                                  |
|  26 | `src/agents/openclaw-tools.types.ts`                                                                      | Composed    | Union sandbox/continuation fields with staged-media and prepared media-read capabilities.                                                                | Tool identity and run owners green.                                 |
|  27 | `src/agents/subagents/registry/subagent-control-messaging.ts`                                             | Deleted     | Accept upstream replacement architecture; control/recovery now lives in split current owners.                                                            | Subagent control/ACP: 148/148.                                      |
|  28 | `src/agents/subagents/registry/subagent-control.test.ts`                                                  | Upstream    | Use tests aligned with current control APIs, not the deleted messaging module.                                                                           | Subagent control/ACP: 148/148.                                      |
|  29 | `src/agents/subagents/registry/subagent-registry-lifecycle-delivery.ts`                                   | Composed    | Adopt requester-settle wake ownership and remove duplicate blocking policy while retaining canonical outcome types.                                      | Subagent owners: 650/650.                                           |
|  30 | `src/agents/subagents/registry/subagent-registry-read.ts`                                                 | Composed    | Retain continuation ancestry reads and add exact scheduler-reservation validation.                                                                       | Subagent owners: 650/650.                                           |
|  31 | `src/agents/subagents/registry/subagent-registry-run-recovery.ts`                                         | Composed    | Preserve durable steer/restart rollback and terminal settlement; adopt authoritative map ownership and split settlement mechanics.                       | Isolated recovery: 41/41.                                           |
|  32 | `src/agents/subagents/registry/subagent-registry-sweeper-recovery.test.ts`                                | Composed    | Keep lifecycle-generation staleness while using current partial real-module mocks.                                                                       | Isolated recovery: 41/41.                                           |
|  33 | `src/agents/subagents/registry/subagent-registry.persistence.test.ts`                                     | Composed    | Union recipient/generation persistence with canonical cleanup, settlement, and orphan-resume cases.                                                      | Registry persistence/recovery: 78/78 focused.                       |
|  34 | `src/agents/subagents/registry/subagent-registry.ts`                                                      | Candidate   | Retain continuation recipient authority, accepted rollback/steer records, and archive deferral; absorb current control through split modules.            | Subagent owners: 650/650.                                           |
|  35 | `src/agents/subagents/registry/subagent-run-liveness.ts`                                                  | Composed    | Keep tunable stale-run policy and use `createdAt` only as a fallback aging floor.                                                                        | Subagent owners: 650/650.                                           |
|  36 | `src/agents/subagents/spawn/acp-spawn.test.ts`                                                            | Composed    | Retain heartbeat request coverage and adopt current runtime/auth separation.                                                                             | Subagent control/ACP: 148/148.                                      |
|  37 | `src/agents/subagents/spawn/subagent-spawn-contract.ts`                                                   | Composed    | Preserve continuation admission/rollback shape and add closure-bound `assertActive` before authority transfer.                                           | Subagent owners: 650/650.                                           |
|  38 | `src/agents/subagents/spawn/subagent-spawn.model-session.test.ts`                                         | Composed    | Keep in-process model override proof and upstream separate auth-profile persistence.                                                                     | Subagent owners: 650/650.                                           |
|  39 | `src/agents/tools-effective-inventory.test.ts`                                                            | Composed    | Move fixtures to concrete WeakMap metadata so plugin/MCP provenance survives normalization.                                                              | Effective inventory: 24/24.                                         |
|  40 | `src/auto-reply/reply/abort.test.ts`                                                                      | Upstream    | Use tests for the current kill-control and registry-read split rather than direct registry mutation.                                                     | Subagent owners: 650/650.                                           |
|  41 | `src/auto-reply/reply/agent-runner-execution.ts`                                                          | Composed    | Carry continuation metadata through settlement and adopt durable compaction plus closed abort outcomes.                                                  | Execution lifecycle/support consumers: 32/32 and 304/304.           |
|  42 | `src/auto-reply/reply/agent-runner-execution.types.ts`                                                    | Composed    | Extend the closed result union with continuation metadata and durable compaction facts.                                                                  | Core/test type graphs green.                                        |
|  43 | `src/auto-reply/reply/agent-runner-result-accounting.persistence.test.ts`                                 | Composed    | Combine continuation/session identity with real reply-operation and canonical session rows.                                                              | Accounting persistence focused suite green.                         |
|  44 | `src/auto-reply/reply/agent-runner-result-accounting.test.ts`                                             | Composed    | Keep continuation/delegate scheduling and move assertions to durable compaction facts/current persistence owners.                                        | Accounting: 14/14.                                                  |
|  45 | `src/auto-reply/reply/agent-runner-result-accounting.ts`                                                  | Composed    | Union continuation/no-op/delegate scheduling with host-bound compaction, fallback, and session usage.                                                    | Accounting: 14/14.                                                  |
|  46 | `src/auto-reply/reply/agent-runner-result-complete.ts`                                                    | Composed    | Keep silent continuation and post-compaction dispatch while treating abort as a typed outcome.                                                           | Auto-reply conflict owners green.                                   |
|  47 | `src/auto-reply/reply/agent-runner-result-payloads.ts`                                                    | Composed    | Retain continuation queue/status facts and upstream usage/fallback payload accounting.                                                                   | Auto-reply conflict owners green.                                   |
|  48 | `src/auto-reply/reply/get-reply.fast-path.test.ts`                                                        | Upstream    | Adopt current isolated store fixture and remove the redundant candidate helper.                                                                          | Fast-path owner tests green; dead exports clean.                    |
|  49 | `src/auto-reply/reply/reply-state.test.ts`                                                                | Composed    | Preserve explicit persisted-row/reset assertions with upstream session/count shapes.                                                                     | Auto-reply conflict owners green.                                   |
|  50 | `src/auto-reply/reply/session-updates.ts`                                                                 | Composed    | Keep successor/usage continuity and upstream serialized exact-writer compaction increments.                                                              | Compaction/accounting owners green.                                 |
|  51 | `src/cli/daemon-cli/install.integration.test.ts`                                                          | Composed    | Keep hermetic environment/mode checks and adopt OS-account profile ownership/restoration.                                                                | CLI conflict owners green.                                          |
|  52 | `src/cli/daemon-cli/install.test.ts`                                                                      | Composed    | Combine hermetic state with canonical system-account home behavior.                                                                                      | CLI conflict owners green.                                          |
|  53 | `src/cli/update-cli.test.ts`                                                                              | Composed    | Retain wrapper path behavior and adopt upstream profile/config ownership and planning.                                                                   | Update CLI: 280/280.                                                |
|  54 | `src/gateway/server-chat.agent-events.test.ts`                                                            | Composed    | Retain terminal-owner/error coverage and add upstream cumulative-usage replay.                                                                           | Gateway server: 346/346.                                            |
|  55 | `src/gateway/server-methods/sessions-compact.ts`                                                          | Composed    | Keep continuation/manual policy with current internal entry and transactional compaction ownership.                                                      | Gateway methods 54/54; isolated compaction 5/5.                     |
|  56 | `src/gateway/server-methods/usage.sessions-usage.test.ts`                                                 | Candidate   | Keep the post-split aggregate suite; detail cases live in their new owner file.                                                                          | Gateway usage: 21/21.                                               |
|  57 | `src/infra/heartbeat-runner-execution.ts`                                                                 | Candidate   | Keep split preparation owner; invocation/orchestration live in current sibling modules.                                                                  | Heartbeat owners: 22/22.                                            |
|  58 | `src/node-host/node-worker-transfer-client.test.ts`                                                       | Upstream    | Use current prepared-project snapshot coverage, executable modes, deletions, reuse, and symlink isolation.                                               | Node transfer owner: 7 passed / 1 platform skip.                    |
|  59 | `src/plugin-sdk/provider-catalog-live-runtime.test.ts`                                                    | Composed    | Keep fetch/auth/pagination in the runtime owner and route config/projection cases to split suites.                                                       | Provider catalog: 25/25.                                            |
|  60 | `src/plugins/wired-hooks-compaction.test.ts`                                                              | Composed    | Retain attribution and upstream terminal-abort behavior: completion is counted, post-abort hooks are not run.                                            | Wired hooks: 10/10.                                                 |
|  61 | `src/sessions/user-turn-transcript.ts`                                                                    | Composed    | Union delivery ack IDs with pending-input custody; freeze replacement once staging/custody starts.                                                       | Transcript owners: 66/66; negative/positive receipt recorded.       |
|  62 | `src/state/openclaw-agent-db-schema.ts`                                                                   | Composed    | Keep one v19 transition containing participant, creator, recipient, and pending-input migrations before one stamp.                                       | Schema v15/v19: 42/42.                                              |
|  63 | `src/state/openclaw-agent-db.test.ts`                                                                     | Composed    | Make downgrade fixtures remove both new table families before exercising predecessor migration.                                                          | Agent DB: 119 passed / 6 platform skips.                            |
|  64 | `src/status/status-text.test.ts`                                                                          | Composed    | Retain continuation lines and upstream global-agent/prepared-context coverage.                                                                           | Status text: 25/25.                                                 |
|  65 | `src/status/status-text.ts`                                                                               | Composed    | Add continuation facts while adopting prepared catalog, agent-scoped reads, and focused auth resolution.                                                 | Status text: 25/25.                                                 |
|  66 | `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md.diff` | Regenerated | Derived prompt bytes must describe the composed tool surface.                                                                                            | Seven prompt snapshots current.                                     |
|  67 | `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md`    | Regenerated | Derived prompt bytes must describe the composed direct-message tool surface.                                                                             | Seven prompt snapshots current.                                     |
|  68 | `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-heartbeat-codex-tool.md.diff`    | Regenerated | Derived prompt bytes must describe the composed heartbeat tool surface.                                                                                  | Seven prompt snapshots current.                                     |
|  69 | `test/tsconfig/tsconfig.core.test.agents-other.json`                                                      | Composed    | Union `agents/tools/**` and `agents/command/**` ownership in the same test type lane.                                                                    | Core test type graph green.                                         |

Codex protocol/runtime evidence was inspected directly at sibling Codex commit
`a25e986323931ec54909b0cd936b612f30c8ce46`: app-server constructs
`AuthManager` with API-key environment loading disabled in
`../codex/codex-rs/app-server/src/lib.rs:507-509,768-770`;
`account/login/start` owns API-key, ChatGPT, device-code, and externally managed
token variants in
`../codex/codex-rs/app-server/src/request_processors/account_processor.rs:283-318`;
the closed variants are declared in
`../codex/codex-rs/app-server-protocol/src/protocol/v2/account.rs:64-108`.
That contract supports explicit harness-owned authentication rather than an
ambient OpenClaw fallback.

### Gate 2 primitive disposition

The original reviewed inventory at bootstrap
`3c5acdb72e94755f469fc6cc3276d5b8623d5b49` reported two rejects:

| Path                                                                     | Canonical result                                                      | Disposition                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agents/embedded-agent-runner/run.continuation-opts-forward.test.ts` | Reject: candidate-only test change                                    | Route to semantic Gate 2.5. Its only material delta adopts the state-backed `createOverflowRunParams` API used by 32 current harness consumers. Restoring the old static `/tmp/workspace` fixture would reintroduce leaked shared state.         |
| `src/agents/embedded-agent-runner/run.overflow-compaction.harness.ts`    | Reject: upstream patch cannot apply cleanly to the accepted candidate | Route to semantic Gate 2.5. The file is test support, and its current composed contract is exercised by continuation integration, overflow, auth, lifecycle, and compaction owners. A whole-file primitive cannot represent a semantic conflict. |

Bootstrap successor `38a833154cba6a9d562302799bff27941aa39dd3`
removes both mutable rows from whole-file enforcement, includes plain
`.harness.ts` support in Gate 2.5 enumeration, and extends the existing
semantic-routing fixture to all four shared test/support surfaces. The exact
`3c5acdb7` inventory is the deterministic negative control: the successor test
rejects it at `run.continuation-opts-forward.test.ts`. The successor fixture
then passes its semantic-merge and production-primitive controls.

Canonical Gate 2 against product `f63ff5a87c41d28dadba1b069654d9c66b4c9dee`
is green: 36 invariants, zero failures, seven exact upstream projections,
three tombstones, and zero empty patterns. No old harness, stale API, or static
`/tmp/workspace` state was restored.

### Gate 2.7 complete mixed-row ledger

The repaired classifier reports zero `FROZEN-STALE` files and 36
`MIXED-CLOBBER` heuristic rows. Every row is dispositioned; none requests an
upstream restoration.

| Path                                                                                                      | Dropped | Disposition      | Exact reason / owner proof                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------: | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/assertion-safety-baseline.txt`                                                                    |       2 | KEEP-COMPOSED    | Shrink-only deletions for assertions removed by typed transcript and message-usage ownership; 12,823-entry assertion ratchet green.                                             |
| `scripts/plugin-sdk-surface-report.mts`                                                                   |       2 | KEEP-COMPOSED    | Numeric budget lines were recomputed from the merged graph; SDK surface check reports the actual 147/4,370/2,596 public surface.                                                |
| `scripts/protocol-gen.ts`                                                                                 |       1 | KEEP-COMPOSED    | Upstream `ProtocolSchemas` parameter was absorbed into the canonical document-builder owner; protocol generation/checks are drift-free.                                         |
| `src/agents/apply-patch.test.ts`                                                                          |       1 | KEEP-COMPOSED    | `withTempDir` was renamed consistently to `withTestDir`; behavior and canonical-path cleanup are unchanged.                                                                     |
| `src/agents/embedded-agent-runner/compact.hooks.test.ts`                                                  |       2 | KEEP-COMPOSED    | Fixed store-path literals were replaced by exact owner-store fixtures; 168/168 hook tests pass.                                                                                 |
| `src/agents/embedded-agent-runner/run/attempt-client-tools.ts`                                            |       5 | KEEP-COMPOSED    | Cast-heavy metadata calls were replaced by object-typed WeakMap APIs without changing plugin ownership; tool identity tests pass.                                               |
| `src/agents/embedded-agent-runner/run/payloads.ts`                                                        |       9 | KEEP-COMPOSED    | Upstream joined-text reuse is retained only for one item; multi-item markers remain positionally parseable; 56/56 pass.                                                         |
| `src/agents/embedded-agent-subscribe.handlers.compaction.test.ts`                                         |       2 | KEEP-COMPOSED    | Upstream event assertions were extended with continuation trigger/count fields rather than dropped; subscriber tests pass.                                                      |
| `src/agents/embedded-agent-subscribe.handlers.compaction.ts`                                              |       2 | KEEP-COMPOSED    | Observed count/operation ID moved to the durable compaction fact owner; subscriber tests pass.                                                                                  |
| `src/agents/embedded-agent-subscribe.handlers.messages.lifecycle.ts`                                      |      18 | KEEP-COMPOSED    | Raw text, commentary, and usage accumulation moved into lifecycle-state/current usage owners; duplicate commentary emission was deleted.                                        |
| `src/agents/embedded-agent-subscribe.handlers.messages.stream.ts`                                         |      17 | KEEP-COMPOSED    | Commentary projection moved to the lifecycle owner; stream code retains only active-item transport projection.                                                                  |
| `src/agents/embedded-agent-subscribe.handlers.messages.update.ts`                                         |       4 | KEEP-COMPOSED    | Raw-stream append and commentary suppression moved to lifecycle state; update projection remains provider-aware.                                                                |
| `src/agents/embedded-agent-subscribe.handlers.tools.completion.ts`                                        |       1 | KEEP-COMPOSED    | `Object.assign` terminal mutation became an explicit typed result and mirrored activity owner; 216/216 pass.                                                                    |
| `src/agents/embedded-agent-subscribe.handlers.tools.start.ts`                                             |       1 | KEEP-COMPOSED    | Question readiness is now async-owner driven; missing questions are handled before this projection.                                                                             |
| `src/agents/embedded-agent-subscribe.ts`                                                                  |       1 | KEEP-COMPOSED    | Inline tool lifecycle construction moved to `embedded-agent-subscribe.tool-lifecycle.ts`; one owner remains.                                                                    |
| `src/agents/embedded-agent-utils.ts`                                                                      |       2 | KEEP-COMPOSED    | Text sanitization is folded into phase-aware final extraction; payload/subscriber suites pass.                                                                                  |
| `src/agents/openclaw-tools.sessions.test.ts`                                                              |       1 | KEEP-COMPOSED    | Store creation moved to the canonical tracked temp-state fixture; session/inventory coverage remains.                                                                           |
| `src/agents/sandbox/remote-fs-bridge.test.ts`                                                             |       1 | KEEP-COMPOSED    | Test fixture rename only (`withTempDir` to `withTestDir`), applied to every caller.                                                                                             |
| `src/agents/tools-effective-inventory.test.ts`                                                            |       3 | KEEP-COMPOSED    | Retired schema-runtime mock was removed; concrete tool metadata now owns plugin/MCP identity; 24/24 pass.                                                                       |
| `src/auto-reply/reply/agent-runner-execution.ts`                                                          |       1 | KEEP-COMPOSED    | Abort handling is the current closed outcome path; terminal callback selection was simplified without changing precedence.                                                      |
| `src/auto-reply/reply/agent-runner-execution-contract.test.ts`                                            |       1 | KEEP-COMPOSED    | Cumulative `agentMeta.compactionCount` remains diagnostic; the fixture now supplies the explicit `contextManagement.lastTurnCompactions` fact owned by current-turn accounting. |
| `src/auto-reply/reply/agent-runner-result-accounting.test.ts`                                             |       3 | KEEP-COMPOSED    | Generic usage mock was replaced by canonical owner behavior and durable compaction facts; 14/14 pass.                                                                           |
| `src/auto-reply/reply/session-usage.ts`                                                                   |       2 | KEEP-COMPOSED    | Usage writes retain upstream transaction fencing through the storage-neutral `updateSessionEntry` facade without consuming continuation persistence faults; 97/97 pass.         |
| `src/auto-reply/reply/session-updates.ts`                                                                 |       2 | KEEP-COMPOSED    | Generic entry spreading moved to exact lifecycle mutation and authoritative timestamps; compaction/accounting tests pass.                                                       |
| `src/gateway/server-methods/usage.sessions-usage.test.ts`                                                 |      29 | KEEP-COMPOSED    | Fixed-store/detail cases moved to `usage.sessions-usage-details.test.ts` and shared support; aggregate owner remains nonduplicative; 21/21 pass.                                |
| `src/infra/heartbeat-runner-execution.ts`                                                                 |       1 | KEEP-COMPOSED    | Internal-turn source classification moved to the invoke/run split; heartbeat owner suite passes.                                                                                |
| `src/node-host/node-worker-transfer-client.git.test.ts`                                                   |       3 | KEEP-COMPOSED    | Exact permission assertions now test executable bits only, avoiding host umask variance while preserving Git mode semantics.                                                    |
| `src/plugin-sdk/provider-catalog-live-runtime.test.ts`                                                    |       1 | KEEP-COMPOSED    | Fetch-guard setup moved to split config/support owners; runtime fetch/auth/pagination coverage remains; 25/25 pass.                                                             |
| `src/plugins/tool-metadata.ts`                                                                            |       5 | KEEP-COMPOSED    | Read/copy APIs accept concrete objects while writes remain typed; WeakMap object identity is unchanged; 24/24 pass.                                                             |
| `src/plugins/wired-hooks-compaction.test.ts`                                                              |       1 | KEEP-COMPOSED    | Expected event now includes continuation trigger/count fields; 10/10 pass.                                                                                                      |
| `src/sessions/user-turn-transcript.message.ts`                                                            |       7 | KEEP-COMPOSED    | Metadata reader was renamed/exported for the canonical owner and now persists deduplicated delivery-ack IDs.                                                                    |
| `src/sessions/user-turn-transcript.ts`                                                                    |       2 | KEEP-COMPOSED    | Casts/fallback reads were replaced by typed config and pending-input custody; transcript owners pass.                                                                           |
| `src/status/status-text.test.ts`                                                                          |       1 | KEEP-COMPOSED    | Import split follows the current status owner; continuation and prepared-context assertions remain; 25/25 pass.                                                                 |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md.diff` |      10 | KEEP-REGENERATED | Counts/hashes are deterministic output from the final tool surface; snapshot check green.                                                                                       |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md`    |       4 | KEEP-REGENERATED | Counts changed with the final dynamic-tool schema; snapshot check green.                                                                                                        |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-heartbeat-codex-tool.md.diff`    |      10 | KEEP-REGENERATED | Counts/hashes describe the final heartbeat tool surface; snapshot check green.                                                                                                  |

### 38-row proof materiality

The immutable historical artifacts remain available, but current proof credit
is decided by bytes from accepted candidate `0ed59cb6` to this successor.
`TRANSPOSE` means every named enforcement owner is byte-identical and only a
new exact-SHA identity receipt is needed. `RERUN` means at least one actual
composition/runtime owner changed and focused tests cannot substitute for the
required behavioral fire.

| Row                             | Status            | Materiality reason                                                                                                                         |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| R-CD-1                          | RERUN             | Spawn, registry, completion delivery, and return owners changed.                                                                           |
| R-CD-2                          | RERUN             | Silent delivery/settlement owners changed.                                                                                                 |
| R-CD-3                          | RERUN             | Compaction runtime and post-compaction delegate owners changed.                                                                            |
| R-CD-4                          | RERUN             | Recipient authority, session storage, and targeted-return settlement changed.                                                              |
| R-CD-CHAINED-DEPTH-2            | RERUN             | Subagent generation, spawn, liveness, and return routing changed.                                                                          |
| R-CD-COLLECTION-ON-COLLAPSE     | RERUN             | Collector restore/settlement and compaction ownership changed.                                                                             |
| R-CD-MODEL-CHAINED-ALT          | RERUN             | Model/session propagation through current spawn owners changed.                                                                            |
| R-CD-MODEL-DEFAULT              | RERUN             | Model/auth separation through current spawn owners changed.                                                                                |
| R-CD-MODEL-TOKEN                | RERUN             | Payload extraction and subagent return composition changed.                                                                                |
| R-CD-MODEL-TOOL                 | RERUN             | Tool identity and subagent spawn composition changed.                                                                                      |
| R-CD-RETURN-OVERLAP             | RERUN             | Queue, transcript custody, recipient authority, and retry owners changed.                                                                  |
| R-CD-SILENT                     | RERUN             | Delivery and terminal settlement owners changed.                                                                                           |
| R-CD-TOKEN                      | RERUN             | Token payload projection and return owners changed.                                                                                        |
| R-CD-RETURN-COVENANT-AUTHORITY  | BLOCKED-ON-DRIVER | `openclaw.k6.return-covenant-fixture-driver.v1` is absent from both exact parents and this successor; no substitute authority is accepted. |
| R-CONFIG-DEFAULTS               | TRANSPOSE         | Continuation resolver/schema/default enforcement bytes are unchanged; only unrelated type additions landed.                                |
| R-CONFIG-INTERSESSION           | RERUN             | Session storage, recipient authority, and restart ownership changed.                                                                       |
| R-CW-1                          | RERUN             | Admission, queue, transcript, and restart flow changed despite unchanged work dispatcher.                                                  |
| R-CW-2                          | TRANSPOSE         | Delay clamp/config and scheduler enforcement owners are byte-identical.                                                                    |
| R-CW-3                          | RERUN             | Span emission call sites and accounting composition changed.                                                                               |
| R-CW-4                          | TRANSPOSE         | Chain state, scheduler, and work-dispatch enforcement owners are byte-identical.                                                           |
| R-CW-5                          | TRANSPOSE         | Cost/pending cap and work-dispatch rejection owners are byte-identical.                                                                    |
| R-CW-5A                         | TRANSPOSE         | Sibling cap-preservation branch is byte-identical in `work-dispatch.ts`.                                                                   |
| R-CW-6                          | TRANSPOSE         | Chain-depth boundary enforcement is byte-identical.                                                                                        |
| R-CW-6A                         | TRANSPOSE         | Sibling depth/cap branch is byte-identical.                                                                                                |
| R-CW-7                          | RERUN             | Trace carrier call sites and session/restart composition changed.                                                                          |
| R-CW-DELEGATE-CHILD-LIVE        | RERUN             | Live child registry/spawn/return owners changed.                                                                                           |
| R-CW-DELEGATE-SELF-CONTINUATION | RERUN             | Self-continuation still crosses changed subagent lifecycle owners.                                                                         |
| R-CW-DELEGATE-TOKEN             | RERUN             | Token extraction and subagent return composition changed.                                                                                  |
| R-CW-MULTI                      | TRANSPOSE         | Multi-election work-dispatch owner and regression test are byte-identical.                                                                 |
| R-CW-MULTI-COLLAPSE             | TRANSPOSE         | Earlier-election preservation on later cap rejection is byte-identical.                                                                    |
| R-CW-TOKEN                      | RERUN             | Final payload/directive composition changed.                                                                                               |
| R-OBS-1                         | RERUN             | Status selection/rendering and agent-scoped reads changed.                                                                                 |
| R-OBS-2                         | RERUN             | Tracer bytes are stable, but emitting call sites and lifecycle owners changed.                                                             |
| R-OBS-STATUS                    | RERUN             | Status composition changed.                                                                                                                |
| R-RC-1                          | TRANSPOSE         | Threshold guard/tool/config enforcement bytes are byte-identical.                                                                          |
| R-RC-2                          | RERUN             | Accepted compaction execution, durable facts, and release owners changed.                                                                  |
| R-REGRESSION-TRAP-TESTS         | RERUN             | Multiple sibling fixtures and production composition points changed.                                                                       |
| R-TRACE-REDACTION-1121          | RERUN             | Redaction patterns/proxy capture dependencies changed upstream.                                                                            |

Totals: 10 `TRANSPOSE`, 27 `RERUN`, one `BLOCKED-ON-DRIVER`, zero
`INVALIDATED`. The missing driver blocks covenant proof only; it does not
erase byte-stable guard credit or the immutable historical corpus.
The `f63ff5a8` absorb-owner repair changes only owners already classified
`RERUN`; no `TRANSPOSE` row or immutable input changed.

### External prerequisite routing

| Prerequisite            | Local state                                                                                                                   | Required owner/action                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate 2 semantic routing | Implemented and pushed at bootstrap `38a833154cba6a9d562302799bff27941aa39dd3`; canonical product check is 36/36 green.       | Scribe/cohort reviews and lands the exact bootstrap successor. Until then Mode-B must pin its published branch; no merged-canon claim is made.                                          |
| Telegram Test Server    | No authenticated `convex` executable and no `OPENCLAW_QA_CONVEX_SITE_URL` / `OPENCLAW_QA_CONVEX_SECRET_CI` pair is available. | Credentialed Telegram QA lane runs doctor and the reaction/system-event recipe against this exact product SHA, preserving `events.ndjson`, summary, gateway log, and provider requests. |
| Codex autoreview        | A fresh 37,254-byte uncommitted repair bundle aborts before review with Codex v0.150.1 `401 invalid_refresh_token`.           | Seat owner reauthenticates Codex and reruns the exact branch review with GPT-5.6 Sol; no alternate engine is substituted.                                                               |
| GitNexus                | Fork source is `3c1e686edfc1acaac882927cada121ddd7c47bcc`; the required prebuilt fork CLI is absent.                          | Install the prebuilt `karmaterminal/GitNexus` fork at this exact source identity before any GitNexus result can be credited.                                                            |
| Return covenant         | Product fixture driver absent in both exact parents and successor.                                                            | Product-driver lane adds the accepted `openclaw.k6.return-covenant-fixture-driver.v1` seam, then fires the 12-case typed-tool/bracket matrix.                                           |

### Mode-B 33374343233 terminal classification and absorb repair

Mode-B run `33374343233` executed product
`cc513ec0acf81d36dde3f1c86925473f8665469b` with workflow
`3c5acdb72e94755f469fc6cc3276d5b8623d5b49`. It ended red: 181,239 passed,
32 failed, three load flakes greened, 29 deterministic failures, 163 shard
summaries, 58 successful jobs, 12 failed jobs including aggregate, one
cancelled job, and four skipped jobs. Routing planned all 167 shards across 69
jobs but validated only 65 receipts.

The four exact receipt gaps are:

| Missing batch      | Classification                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hosted-batch-009` | Hosted `extensions` shard was repeatedly SIGKILLed on the 2-core/7-GB worker; the job was cancelled after 88 minutes and uploaded no `batch-rc` or routing receipt.                                    |
| `local-batch-058`  | ARM64 dependency seeding failed before tests: the Matrix native download hit `ECONNREFUSED` / `ETIMEDOUT`, then dependency script 0.6.6 threw `ReferenceError: err is not defined`; no receipt formed. |
| `dist-batch-068`   | `core-runtime-tui-pty` was skipped because the static gate failed and test fanout after static failure was disabled.                                                                                   |
| `dist-batch-069`   | `core-support-boundary` was skipped by the same static-gate fanout policy.                                                                                                                             |

The static artifact passed UI raw-window, protocol generation, plugin assets,
and strict build smoke. Its aggregate `pnpm check` failed only because the
core Oxlint subprocess returned exit 1 after 205 seconds without emitting a
diagnostic; exact local `pnpm check` at the product SHA was green. No candidate
byte is attributed from a diagnostic-free remote exit.

Classification terms:

- `REPAIRED-ABSORB`: deterministic at `cc513ec0`, green at the exact owning
  parent, and green after the `f63ff5a8` owner repair.
- `INHERITED-0ED`: the same exact row is already present in accepted-candidate
  Mode-B `33323536011`; it is not caused by this absorb.
- `NONREPRO-LOAD` / `NONREPRO-ORDER`: absent from the prior candidate
  deterministic set and green under an exact-head focused rerun.

|   # | Exact deterministic failure                                                                                                                          | Classification  |
| --: | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
|   1 | `src/agents/subagents/registry/subagent-control.retirement.test.ts` — retained successor after failed rollback                                       | REPAIRED-ABSORB |
|   2 | `extensions/diagnostics-otel/src/codex-dynamic-tool-origin.integration.test.ts` — exports Codex dynamic continuation origins                         | INHERITED-0ED   |
|   3 | `src/gateway/session-utils.queued-collector.test.ts` — second collector create projection remains queued                                             | REPAIRED-ABSORB |
|   4 | `extensions/codex/src/app-server/run-attempt.dynamic-tools.test.ts` — default credential wait without harness cancellation                           | NONREPRO-LOAD   |
|   5 | `src/gateway/server.chat.acp-completion.test.ts` — runtime timeout completion ownership                                                              | INHERITED-0ED   |
|   6 | `src/gateway/server.chat.acp-completion.test.ts` — suppressed runtime timeout completion ownership                                                   | INHERITED-0ED   |
|   7 | `src/auto-reply/reply/agent-runner.continuation-work-span.reservation.test.ts` — preserves concurrent child-token updates                            | REPAIRED-ABSORB |
|   8 | `src/auto-reply/reply/agent-runner.continuation-work-span.test.ts` — failed durable reservation does not arm work                                    | REPAIRED-ABSORB |
|   9 | `src/auto-reply/reply/agent-runner.continuation-work-span.test.ts` — disablement during persistence rolls reservation back                           | REPAIRED-ABSORB |
|  10 | `src/auto-reply/reply/agent-runner.continuation-work-span.test.ts` — hot-reloaded limits after durable reservation                                   | REPAIRED-ABSORB |
|  11 | `src/auto-reply/reply/agent-runner.continuation-work-span.test.ts` — live limit increase cannot exceed durable reservation                           | REPAIRED-ABSORB |
|  12 | `src/auto-reply/reply/agent-runner.continuation-work-span.test.ts` — parked work survives zero new reservation slots                                 | REPAIRED-ABSORB |
|  13 | `src/auto-reply/reply/agent-runner.continuation-work-span.test.ts` — hedge-fired delegate remains recoverable after persistence failure              | REPAIRED-ABSORB |
|  14 | `src/auto-reply/reply/agent-runner.media-paths.test.ts` — final MEDIA path normalization                                                             | NONREPRO-LOAD   |
|  15 | `src/agents/embedded-agent-subscribe.subscribe-embedded-agent-session.reasoning-delivery.test.ts` — streamed commentary item identity                | REPAIRED-ABSORB |
|  16 | `src/agents/embedded-agent-subscribe.subscribe-embedded-agent-session.reasoning-delivery.test.ts` — snapshot-only commentary item identity           | REPAIRED-ABSORB |
|  17 | `src/agents/embedded-agent-subscribe.subscribe-embedded-agent-session.reasoning-delivery.test.ts` — equal snapshot-only commentary item identity     | REPAIRED-ABSORB |
|  18 | `src/agents/embedded-agent-subscribe.subscribe-embedded-agent-session.subscribeembeddedagentsession.test.ts` — unknown streamed cost remains unknown | REPAIRED-ABSORB |
|  19 | `src/agents/subagent-announce.crosssession-gate.test.ts` — case 7 disabled bracket target                                                            | INHERITED-0ED   |
|  20 | `src/agents/subagent-announce.crosssession-gate.test.ts` — case 10 enabled bracket fanout                                                            | NONREPRO-ORDER  |
|  21 | `test/scripts/full-release-validation-state.test.ts` — monotonically newer exact-child attempt                                                       | INHERITED-0ED   |
|  22 | `test/scripts/full-release-validation-state.test.ts` — preserve snapshot through HTTP 503                                                            | INHERITED-0ED   |
|  23 | `test/scripts/full-release-validation-state.test.ts` — preserve snapshot through HTTP 429                                                            | INHERITED-0ED   |
|  24 | `test/scripts/full-release-validation-state.test.ts` — preserve snapshot through HTTP 403                                                            | INHERITED-0ED   |
|  25 | `test/scripts/full-release-validation-state.test.ts` — preserve snapshot through `ECONNRESET`                                                        | INHERITED-0ED   |
|  26 | `test/scripts/full-release-validation-state.test.ts` — preserve composite evidence when the run read succeeds but jobs fail                          | INHERITED-0ED   |
|  27 | `src/infra/state-migrations.media-persistence.historical-v14.test.ts` — historical v14 media migration                                               | INHERITED-0ED   |
|  28 | `src/infra/state-migrations.media-persistence.historical-v15.test.ts` — historical v15 media migration                                               | INHERITED-0ED   |
|  29 | `extensions/telegram/src/model-callback.loopback.integration.test.ts` — opaque callback loopback                                                     | INHERITED-0ED   |

The 13 absorb rows share four ownership repairs:

| Owner boundary                  | Root cause and canonical repair                                                                                                                                                                                                                                            | Successor proof                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Registration rollback           | Partial-registration ownership was correct, but the aggregate top-level message hid the rollback rejection. Preserve `new-row-survived` and include the rollback diagnostic.                                                                                               | Retirement 26/26; rollback/partial-registration/continuation-drain 23/23.                      |
| Collector lifecycle publication | The create event ran before scheduler activation established a real capacity wait. Keep session/spawn facts synchronous, then activate and publish within accepted rollback ownership.                                                                                     | Queued projection 34/34; adjacent gateway owners 49/49; nested spawn/scheduler owners 119/119. |
| Session usage persistence       | Upstream usage accounting called the same low-level patch primitive candidate continuation tests reserve for chain-state commits, consuming continuation faults and reordering config transitions. Route usage through the semantic accessor while retaining commit hooks. | Continuation/accounting 97/97.                                                                 |
| Commentary and usage projection | Tool handoff reread the cumulative provider message and message-end reread repaired zero usage. Scope commentary to the active item, reset per-item display state, and leave pristine usage recording with the dispatcher.                                                 | Subscriber/lifecycle/accumulator 168/168.                                                      |

The repair commit is
`f63ff5a87c41d28dadba1b069654d9c66b4c9dee`. Production delta is seven files,
`+50/-31` (net `+19`) for the accessor contract and three owner-boundary
repairs; test/ratchet delta is two files, `+2/-2`. Core production types and
core Oxlint pass. The changed-plan tsgo shard-budget guard remains independently
red at both `cc513ec0` and `f63ff5a8` (`agents-root` 739 > 720), so it is not
attributed to this repair.

Fresh Gate 2.5 after the repair enumerates 1,783 upstream-touched test/support
paths, 98 feature intersections, 94 runnable tests, and four support surfaces.
All 29 routed shards pass: 7,311 passed, zero failed, seven platform-skipped.
Support owners pass 304/304 execution, 307/307 gateway, 217/217 embedded, and
11/11 overflow assertions. Gate 2.7 examines 962 paths: 612 `GENUINE`, 36
`MIXED-CLOBBER`, 314 `SAFE-NEW`, zero `FROZEN-STALE`. The feature envelope is
956 to 962 (`+6`): 447 authored feature, 30 required composed owners, 11
generated outputs, 474 test/proof support, zero unexplained. Exact
`src/skills/**`, `.github/labeler.yml`, new `skills/**/SKILL.md`, root
detritus, and unrelated docs/assets counts are all zero; Barnacle Gate 4.8
passes.

A fresh Mode-B must target the eventual journal successor with workflow branch
`codeagent/129388-primitive-core-routing-gap-cure-20260831`. Its terminal
receipt belongs in the external handoff so the tracked journal does not move
the exact tested product SHA afterward.
