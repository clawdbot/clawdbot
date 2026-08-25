# Drift-cure journal: 85651 upstream 1ba243c8 gates

## 2026-08-25T11:13Z - §0 authorities and dispatch baseline

The lane starts from pure continuation `80311e8aa07fd560cb957475517c5ea18164541c`.
The existing savegame resolves to that same byte on the server, so no replacement
savegame was created. The unchanged lane branch was published before lane-ref
evidence was credited.

The governing runbook is the 823-line blob at
`karmaterminal/openclaw-bootstrap:main@342cc9c6d190e1ba57d9995d29e394c993a3e79b`
(SHA-256 `899b6c0e6655cac4c2798d4a7af40320e2a082b16e99b2a8f8df4db1dbc9cfe8`).
The canonical local bootstrap checkout carried an older 716-line copy, so this
cycle reads and applies the server-resolved blob instead.

| Role                      | Named ref                                                      | Local/object                               | Tracking                                   | Server                                     | Equality / disposition                                                    |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| Product / pure base       | `origin/codeagent/openclaw-85651-modeb-cure-20260824`          | `80311e8aa07fd560cb957475517c5ea18164541c` | `80311e8aa07fd560cb957475517c5ea18164541c` | `80311e8aa07fd560cb957475517c5ea18164541c` | equal                                                                     |
| This safe lane            | `origin/codeagent/85651-upstream-1ba243c8-gates`               | `80311e8aa07fd560cb957475517c5ea18164541c` | `80311e8aa07fd560cb957475517c5ea18164541c` | `80311e8aa07fd560cb957475517c5ea18164541c` | equal after unchanged publish                                             |
| CI workflow               | `karmaterminal/openclaw-bootstrap:main`                        | `342cc9c6d190e1ba57d9995d29e394c993a3e79b` | `342cc9c6d190e1ba57d9995d29e394c993a3e79b` | `342cc9c6d190e1ba57d9995d29e394c993a3e79b` | equal; read-only, Mode-B excluded by workorder                            |
| Presentation              | `origin/codeagent/openclaw-85651-final-reproof-20260823`       | `30e9051e2a79b4f70e9e7429561ccd395ed9f4ab` | `30e9051e2a79b4f70e9e7429561ccd395ed9f4ab` | `30e9051e2a79b4f70e9e7429561ccd395ed9f4ab` | equal; read-only                                                          |
| Docs / published proof    | `karmaterminal-openclaw-docs:main`                             | `86b39d87e0ae4eef980496d3742e83033ee84a93` | `86b39d87e0ae4eef980496d3742e83033ee84a93` | `86b39d87e0ae4eef980496d3742e83033ee84a93` | equal; read-only                                                          |
| Savegame                  | `origin/savegame/85651-pre-upstream-1ba243c8-20260825T105739Z` | `80311e8aa07fd560cb957475517c5ea18164541c` | `80311e8aa07fd560cb957475517c5ea18164541c` | `80311e8aa07fd560cb957475517c5ea18164541c` | equal                                                                     |
| Frozen upstream control   | commit object                                                  | `0d4e369b1c3df59cd77b59bba87aac17884742b1` | N/A                                        | N/A                                        | object present; ancestor of pure                                          |
| New upstream to absorb    | pinned `upstream/main` byte                                    | `1ba243c88ed800986909bc50e4ce7b8139891b94` | `9f472253d49ac6992d0eecd528230e2e1543514d` | `9f472253d49ac6992d0eecd528230e2e1543514d` | live ref advanced; pinned byte fetched and remains this cycle's authority |
| Runtime composite context | `origin/codeagent/openclaw-85651-runtime-composite-20260825`   | `37300f29a7ec1f731575343c2aa73ae25f1d0efb` | `37300f29a7ec1f731575343c2aa73ae25f1d0efb` | `37300f29a7ec1f731575343c2aa73ae25f1d0efb` | equal; context only                                                       |

`rerere.enabled=true`, `rerere.autoupdate=true`, and
`merge.conflictstyle=zdiff3` were already configured and were verified before
motion. Live `upstream/main` advanced after dispatch to
`9f472253d49ac6992d0eecd528230e2e1543514d`; widening this cycle would violate
the frozen workorder, so the newer tip is deferred to the next decision.

The pre-merge overlap inventory reproduces the dispatch baseline exactly:
947 pure paths, 1,340 upstream paths, 85 both-touched paths, and 16 textual
conflicts from a non-mutating `git merge-tree --write-tree`.

The mandatory pre-merge Gate 2.7 census used exact upstream
`1ba243c88ed800986909bc50e4ce7b8139891b94`, pure
`80311e8aa07fd560cb957475517c5ea18164541c`, and PR-creation anchor
`7b0d8726cb81775cc63b5e5dc394acc989a455eb`. It examined 947 files and reported:

| Class           | Count |
| --------------- | ----: |
| `SAFE-NEW`      |   299 |
| `GENUINE`       |   261 |
| `MIXED-CLOBBER` |   387 |
| `FROZEN-STALE`  |     0 |

No workorder FROZEN/MIXED snapshot count was supplied, so dispatch-count delta
is N/A. The 387 MIXED rows are a review queue, not automatic defects; every row
will receive a final keep/restore disposition after the merge. The exact
classifier script matches bootstrap `main@342cc9c6`; the exact primitive-core
inventory differs from the stale local checkout and will therefore be supplied
from the server-resolved bootstrap commit for Gate 2.

## 2026-08-25T11:21Z - §1 ordinary back-merge and textual conflict resolution

Commit `456ffaa2f90e80cb29f4c3af60ac43a9fd22ed4a` is the ordinary merge commit.
Its first parent is journal-bearing pure descendant
`5316949a0f524c40e87e273ccfc1fcba69e1a7e7`; its second parent is exact upstream
`1ba243c88ed800986909bc50e4ce7b8139891b94`. No rebase, squash, cherry-pick, or
force-push was used.

The Codex package advanced from `@openai/codex` 0.148.0 to 0.149.1. Before
resolving Codex paths, the exact sibling source tag `rust-v0.149.1` was inspected
at `ff29a44391deccde0aba0f8390337d7f3c319ea4`. In that source,
`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:59-111` defines optional
thread-start approval, sandbox, developer-instruction, and ephemeral fields;
`codex-rs/app-server-protocol/src/protocol/common.rs:1164-1169` owns
`account/login/start`; `common.rs:1653-1686` separates command approval, MCP
elicitation, and dynamic-tool requests; and
`codex-rs/app-server-protocol/src/protocol/v2/account.rs:64-90,696-703` confirms
API-key login and completion shapes. Upstream commit `b68c1366090` intentionally
removed Computer Use readiness-thread security overrides and added a regression
requiring managed security-policy inheritance, so retaining the old explicit
`danger-full-access` / approval policy would have reversed current upstream
behavior even though those protocol fields remain legal.

| Conflict path(s)                                                          | Resolution and preserved invariant                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/codex/src/app-server/auth-bridge.test.ts`                     | Kept the pure canonical `withTestDir` migration while retaining upstream managed-marketplace setup and the `reconcileCodexComputerUseStartArtifacts` owner boundary. Converted newly absorbed upstream temp-dir calls to the same canonical helper.         |
| `extensions/codex/src/app-server/computer-use.ts`, `computer-use.test.ts` | Adopted upstream 0.149.1 managed-security inheritance for the readiness thread; retained upstream config coverage and removed now-unused policy-helper imports.                                                                                             |
| `extensions/codex/src/app-server/shared-client.test.ts`                   | Kept pure `withTestDir` and upstream `createDeferred` lifecycle coverage.                                                                                                                                                                                   |
| `packages/agent-core/src/agent-loop.test.ts`                              | Preserved pure repeated-tool-error termination/redaction coverage and upstream's shared deferred-tool stream helper.                                                                                                                                        |
| `src/agents/command/attempt-execution.ts`                                 | Preserved forked-session restoration and media-task invalidation, plus upstream's latest-store CLI session-binding revalidation before a destructive fresh retry.                                                                                           |
| `src/agents/embedded-agent-runner/run/attempt-client-tools.ts`            | Kept loop detection local to tool construction per upstream's narrowed phase contract; retained `replaySafeToolNames` for stream preparation and subscription trust.                                                                                        |
| `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts`            | Adapted pure runtime-config snapshot setup onto upstream's canonical `createBaseRun(...).run()` helper.                                                                                                                                                     |
| `src/gateway/server-chat.agent-events.test.ts`                            | Kept upstream Guardian reconnect-snapshot coverage but did not resurrect the obsolete validation-summary callback test removed by pure commit `a491b32e26e`; that ownership moved to terminal/subscription resolution tests.                                |
| `src/gateway/server-methods/chat.directive-tags.test.ts`                  | Used upstream source-reply helpers while retaining the pure assertion that the terminal claim is recorded before final broadcast.                                                                                                                           |
| `src/gateway/server-runtime-services.ts`                                  | Adopted upstream's single scheduler-owned post-ready flow instead of retaining the now-dead intermediate helper. Pure delegate-artifact cleanup remains owned by `clearGatewayMaintenanceHandles` and is exercised through the upstream shutdown-race path. |
| `src/state/openclaw-state-db-contract.ts`                                 | Unioned pure delegate-artifact first-use tables with upstream `execution_owner_lifecycle_bindings`; schema version remains 9 because both are additive lazy tables already present in canonical SQL and generated declarations.                             |
| Three Codex prompt Markdown snapshots                                     | Regenerated all prompt fixtures from the merged source with `pnpm prompt:snapshots:gen`; `pnpm prompt:snapshots:check` reports all seven current.                                                                                                           |
| `test/scripts/full-release-validation-at-sha.test.ts`                     | Kept pure bare-origin ref inspection and upstream's queued/in-progress parent-state fixture controls.                                                                                                                                                       |

All 16 textual conflicts were resolved with no remaining unmerged entries.
The exact dependency install was prepared in a normal same-host clone at
`1ba243c88ed800986909bc50e4ce7b8139891b94`; its `package.json` and
`pnpm-lock.yaml` hashes equal the merged worktree, and this linked worktree now
points at that clone's `node_modules`.

## 2026-08-25T12:29Z - §2 Gates 2, 2.5, and 2.7

### Complete 85-path semantic-overlap disposition

The Gate 2 projection algorithm was run over the complete frozen 85-path
intersection. Sixty-eight paths are `EXACT_PURE_PLUS_UPSTREAM`: each candidate
blob equals the deterministic application of the pinned upstream delta to the
pure blob. The remaining 17 paths were manually reviewed:

| Path                                                                                                   | Disposition                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/codex/src/app-server/auth-bridge.test.ts`                                                  | Keep canonical `withTestDir` plus upstream managed-marketplace/reconcile coverage.                                                                               |
| `extensions/codex/src/app-server/computer-use.test.ts`                                                 | Use upstream 0.149.1 managed security-policy inheritance; the former readiness override is intentionally superseded.                                             |
| `extensions/codex/src/app-server/computer-use.ts`                                                      | Use upstream 0.149.1 managed security-policy inheritance; the dependency still accepts overrides, but upstream deliberately rejects them for this managed probe. |
| `extensions/codex/src/app-server/shared-client.test.ts`                                                | Keep canonical `withTestDir` plus upstream deferred lifecycle coverage.                                                                                          |
| `packages/agent-core/src/agent-loop.test.ts`                                                           | Keep pure repeated-tool-error termination/redaction regressions plus upstream deferred-stream helper.                                                            |
| `src/agents/command/attempt-execution.ts`                                                              | Keep pure fork recovery and media invalidation plus upstream latest session-binding revalidation.                                                                |
| `src/agents/embedded-agent-runner/run/attempt-client-tools.ts`                                         | Keep loop detection at the tool-construction owner and upstream's narrowed returned phase state.                                                                 |
| `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts`                                         | Apply pure runtime-config setup to upstream's canonical `createBaseRun` helper.                                                                                  |
| `src/gateway/server-chat.agent-events.test.ts`                                                         | Preserve pure terminal-summary ownership and add upstream Guardian reconnect-snapshot coverage without resurrecting the retired callback seam.                   |
| `src/gateway/server-methods/chat.directive-tags.test.ts`                                               | Use upstream source-reply fixtures and retain the pure terminal-before-broadcast assertion.                                                                      |
| `src/gateway/server-methods/server-methods.test.ts`                                                    | Adapt the upstream-added validation-loop assertion to pure's canonical `projectChatDisplayMessages` API.                                                         |
| `src/gateway/server-runtime-services.ts`                                                               | Keep upstream's scheduler owner and pure delegate-artifact cleanup in `clearGatewayMaintenanceHandles`; do not retain the dead intermediate helper.              |
| `src/state/openclaw-state-db-contract.ts`                                                              | Union additive delegate-artifact and execution-owner first-use tables at schema version 9.                                                                       |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md`   | Accept canonical merged generator output.                                                                                                                        |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md` | Accept canonical merged generator output.                                                                                                                        |
| `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-heartbeat-codex-tool.md`      | Accept canonical merged generator output.                                                                                                                        |
| `test/scripts/full-release-validation-at-sha.test.ts`                                                  | Apply pure's bare-origin helper to upstream parent-state coverage.                                                                                               |

The complete 85-row local ledger is `overlap-dispositions.tsv`, SHA-256
`83fadfcfe479cdd7b89a5d47a1f6daa198a687efe4abbe84fb8289dfa4a3af71`.
Its source list is the exact 947/1,340 intersection and contains no omitted
path.

### Gate 2

Canonical bootstrap-main `feature-cores-byte-check.sh`, using the exact
bootstrap-main primitive-core inventory, passed all 40 invariants at successor
`3b969b145340c65c3be919890be400393da99566`: 34 byte-identical, three exact
upstream projections, and three tombstones.

### Gate 2.5

The frozen upstream range contains 547 touched test files. Thirty-seven
intersect the pure feature surface. Every intersection was run locally through
its owning Vitest config with `--maxWorkers=1` at exact successor
`3b969b145340c65c3be919890be400393da99566`: 37 files, 4,093 passed assertions,
and two platform skips.

The first merge checkpoint `2f4b7be93812b96c4e5a780959cedb46955f59fa`
provided two deterministic negative controls:

1. `src/gateway/server-methods/server-methods.test.ts` failed because an
   upstream-added test called removed `projectRecentChatDisplayMessages`.
   Exact upstream `1ba243c8` passed its 218-test file; the successor calls the
   canonical pure `projectChatDisplayMessages` owner and passes 220/220 plus the
   full six-file gateway intersection set (847/847).
2. `test/scripts/full-release-validation-at-sha.test.ts` failed because an
   upstream-added parent-status case called `runGit` against a bare origin.
   Exact upstream reproduced the same bare-repository failure class in three
   cases. Pure had already introduced `runBareGit` and repaired two of them; the
   successor applies that owner helper to the new case and passes 31/31.

Additional owner-boundary coverage passed for client-tool phase/session
preparation, gateway subscription ownership, SQLite first-use schema,
compaction/overflow, continuation delivery, session cleanup/recovery, cron
state, task-flow persistence/maintenance, display projection, doctor runtime,
and generated prompt snapshots.

### Gate 2.7

At exact successor `3b969b145340c65c3be919890be400393da99566`,
the canonical walker examined 946 files:

| Class           | Count |
| --------------- | ----: |
| `SAFE-NEW`      |   300 |
| `GENUINE`       |   294 |
| `MIXED-CLOBBER` |   352 |
| `FROZEN-STALE`  |     0 |

Every final MIXED row was joined to the pre-merge pure census. There are zero
new or increased rows: 311 are unchanged inherited feature differences, 41
decreased because the pinned merge restored upstream lines, and 35 baseline
rows cleared entirely. The deterministic disposition is therefore
`KEEP_INHERITED_FEATURE` for all 311 unchanged rows and
`KEEP_INHERITED_REMAINDER` for all 41 decreased rows; no row remains
`REVIEW_REQUIRED`.

The complete 352-row disposition ledger is `mixed-dispositions.tsv`, SHA-256
`7cf8902b89eabadbf0e411d1ba404eb6c8e11aebe741f4377b56a56edc162c4b`.
The pre-merge classification SHA-256 is
`b6b1c43e069957d279687bbad49aadafe7484e45d25983116bf4f96cf542b328`;
the final classification SHA-256 is
`bd4b9ff2972dd543ac413c9f7eb76dd5b135675a0db0a29f24688b597265b45e`.
