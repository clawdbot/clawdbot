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
