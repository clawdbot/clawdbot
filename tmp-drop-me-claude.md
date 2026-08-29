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
