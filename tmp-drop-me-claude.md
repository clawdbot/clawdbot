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
