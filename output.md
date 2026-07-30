# 1172 absorb — exact-control triage of unresolved test residuals

Lane branch: `codeagent/1172-absorb-residual-triage-opus5`
Bound issue: karmaterminal/openclaw#1197 (tracking also #1198, Project 85)

Predecessor absorb report preserved verbatim at `output-absorb-1172.md`.

> **STATUS: WORK IN PROGRESS.** Gateway control runs still executing. Final verdict at §9.

## 1. Exact bytes and topology

| Role | SHA | Worktree |
| --- | --- | --- |
| Candidate | `cad0b99de23822698d477ac7b1618a3e8ce22ae8` | `WORKTREES/openclaw-1172-absorb-residual-triage-opus5` (lane) |
| Assembly control | `16f4b3f106033f7fe75f68e67563db1b5b4d0e2f` | `WORKTREES/ctl-asm-16f4b3f1` (detached) |
| Upstream control | `cc48aef143551af2ce13096264335ce9954e61e6` | `WORKTREES/ctl-ups-cc48aef1` (detached) |
| Merge base | `20eda756fae6599bc9d776815016f555a64d77d6` | — |

Two-parent merge verified before any test ran:

```
git log --merges --format='%h %p | %s' cad0b99d --not 16f4b3f1
→ 9ed7fd20b49 16f4b3f1060 cc48aef1435 | merge: absorb upstream cc48aef into continuation assembly
git merge-base --is-ancestor 16f4b3f1 cad0b99d   → true
git merge-base --is-ancestor cc48aef1 cad0b99d   → true
```

Both controls are ancestors of the candidate through exactly the stated merge. No tree was moved,
fetched, rebased, or force-pushed. Lane `HEAD` was `cad0b99de23` at start and is unchanged apart
from this report.

## 2. Environment

| Item | Value |
| --- | --- |
| Host | Linux, 20 cores, 121 GB RAM, load ~4 at lane start |
| Node | v25.9.0 |
| Vitest | 4.1.10 |
| Node default heap ceiling | **4288 MB** (main thread *and* worker threads; no `--max-old-space-size` is set for these shards) |
| Runner | `node scripts/test-projects.mjs <file>` and `node scripts/run-vitest.mjs run --config … ` only |

**Control dependency policy.** Both control worktrees were given the candidate's dependency tree by
mirroring all 164 `node_modules` paths as symlinks (root `node_modules` already is a symlink to the
shared install). This deliberately holds dependencies *constant* so the only variable across the
three runs is source bytes — which is what a control requires. Caveat recorded in §8.

Runs were kept strictly serial. `node_modules/.vite` is one physical directory shared by all three
worktrees, so concurrent Vitest across them would race; and the gateway worker death is
resource-sensitive, so added load would confound it.

## 3. Residual matrix (three trees)

| # | File | Candidate | Assembly `16f4b3f1` | Upstream `cc48aef1` | Classification |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/entry.respawn.test.ts` | 2 failed / 21 | 2 failed / 21 | 2 failed / 21 | **ENVIRONMENT** (host) |
| 2 | `src/commands/sandbox-explain.test.ts` | 7 failed / 12 → **12 passed** after quarantine | 7 failed / 12 | 7 failed / 12 | **ENVIRONMENT / STALE-STATE** |
| 3 | `extensions/anthropic/session-catalog.test.ts` | F, F, P, F (~50 %) | — | 53 passed / 53 | **ENVIRONMENT** (host fs) / upstream-inherited |
| 4 | `src/cli/plugins-cli.install.test.ts` | 177 passed / 177 isolated | — | — | **NOT-REPRODUCIBLE** isolated → load/order |
| 5 | `src/plugins/npm-install-security-scan.release.test.ts` | 78 passed / 78 isolated | — | — | **NOT-REPRODUCIBLE** isolated → load/order |
| 6 | `src/gateway/server-cron*` | in gateway shard | pending | pending | pending |
| 7 | `src/gateway/server-restart-sentinel*` | in gateway shard | pending | pending | pending |
| 8 | gateway-server shard worker death | died at **136 / 203** files | pending | pending | pending |

## 4. Root-cause clusters

### 4.1 `entry.respawn` — host CA probe, byte-identical everywhere

`src/entry.respawn.ts` (`a55d3df7ada`) and `src/entry.respawn.test.ts` (`7e0fc4685e3`) are the **same
blob on all three trees**, so a candidate regression is impossible by construction; the identical
2/21 failure on all three confirms it empirically.

`buildCliRespawnPlan` only honours the injected `platform` for the Windows branch. When the caller
passes `autoNodeExtraCaCerts: undefined` it falls back to

```ts
resolveNodeStartupTlsEnvironment({ env, execPath, includeDarwinDefaults: false }).NODE_EXTRA_CA_CERTS
```

which probes the **real host filesystem**. This Linux box has `/etc/ssl/certs/ca-certificates.crt`,
so the two cases that assert `toBeNull()` under `platform: "darwin"` receive a respawn plan carrying
`NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`. Upstream-owned, host-dependent, outside
absorb scope.

### 4.2 `sandbox-explain` — stale SQLite at fixed `/tmp` paths (proven by ablation)

Failure shape: `OpenClawAgentDatabaseMediaMigrationRequiredError: … uses schema version 9`.

`OPENCLAW_AGENT_SCHEMA_VERSION` is `16` in `src/state/openclaw-agent-db-contract.ts` on **all three
trees**, and `src/commands/sandbox-explain.ts` is the same blob (`9519e9d5544`) on all three, so a
sub-16 database is refused identically everywhere.

The test configures `session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" }` — a fixed,
machine-global path (unlike the `mkdtemp` used elsewhere in the same file), so a stale database left
by any older checkout on this host poisons it.

Ablation: 3 stale files (`user_version` 9) were moved to `/tmp/absorb-triage-quarantine/sqlite`
(moved, not deleted — reversible), after which the candidate returned **12 passed / 12**. Note the
predecessor lane's `/tmp/absorb-quarantine` no longer exists and 2199 `*.sqlite` files were present
again at lane start, so this residue **recurs** on this host and is not a one-time cleanup.

### 4.3 `anthropic/session-catalog` — host `utimes`/`stat` millisecond rounding, ~50 % flaky

Candidate's test (`a21f93dfe05`) and source (`ceddf60995c`) blobs are **identical to upstream's** and
differ from the assembly's, i.e. the candidate adopted upstream wholesale. Yet the upstream control
**passed 53/53** with those same bytes while the candidate failed. That proves non-determinism, not
regression — confirmed by four candidate runs: fail, fail, **pass**, fail.

Root cause is below OpenClaw entirely. A bare-Node probe with no repository code:

```
node -e 'fs.utimesSync(p,d,d); fs.statSync(p).mtimeMs'
set: 1785396886396  →  read back: 1785396886395.999
utimes round-trip mismatches: 2480/5000 (49.6 %)   [Node v25.9.0, this filesystem]
```

The test pins `appendedAt = new Date(baseNow + 2_000)` and asserts exact `toBe(appendedAt.getTime())`
equality against the value read back through `stat`, so it coin-flips per run on this host.

### 4.4 `plugins-cli.install` / `npm-install-security-scan.release` — clean in isolation

Both pass fully in isolation on the candidate (177/177 and 78/78). The predecessor's full-suite logs
are unrecoverable (`/tmp/full-suite2.log` is a June artifact from an unrelated lane), so the original
failure text is not available; classification therefore rests on reproduction.

`plugins-cli.install.test.ts` uses machine-global fixed roots — `const CLI_STATE_ROOT =
"/tmp/openclaw-state"`, `const PROFILE_STATE_ROOT = "/tmp/openclaw-ledger-profile"` — which is the
same hygiene defect class as §4.2 and is contention-prone under full-suite parallelism.
`npm-install-security-scan.release.test.ts` is by contrast `mkdtemp`-hygienic and is the same blob on
all three trees.

## 5. Merge-completeness audit of the one both-sides-different gateway surface

`src/gateway/server-restart-sentinel.ts` and `.test.ts` are the only residual-implicated files whose
bytes differ from **both** controls, so they were the prime regression suspect and were audited
line-by-line rather than sampled.

| File | base → upstream | base → assembly | Verdict |
| --- | --- | --- | --- |
| `server-restart-sentinel.ts` | +15 / −0 (`controlPlaneOnlyConfigRestart`) | +9 / −230 (extraction into `server-restart-sentinel-delivery.ts`) | union present |
| `server-restart-sentinel.test.ts` | +61 / −0 | +304 / −0 | union present |
| `server-restart-sentinel-delivery.ts` | **untouched by upstream** | +411 (new, assembly-owned) | no upstream edit to clobber |

Both sides are purely additive and non-overlapping, so differing from both controls is the *expected*
union, not drift. A per-line scan of every line upstream added to the test file found **zero missing
lines** in the candidate, and both upstream-added test titles are present. Because upstream never
edited the function the assembly extracted, the extraction could not have silently dropped an
upstream change — the classic absorb failure mode is excluded here by evidence, not assumption.

## 6. Gateway worker death (in progress)

Candidate reproduction, shard run in isolation via
`node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway-server.config.ts`:

- **136 of 203** shard files reported, then `Error: Worker exited unexpectedly` (`node:internal/worker`),
  exit 1, no per-test failure preceding it.
- The predecessor's claim that the worker dies *immediately after*
  `server.sessions.process-cleanup.test.ts` is **not what this run shows**: that file passed
  (2 tests, 2920 ms) and two further files passed after it —
  `session-observer-bookkeeping.test.ts` and `server.sessions.face.test.ts` — before the exit.
- The shard is configured `fileParallelism: false, isolate: false`, so all 203 files run sequentially
  **in one worker with no module isolation**, and heap accumulates monotonically.
- `--logHeapUsage` on the assembly control shows **2735 MB used by file 40** and still climbing,
  against a measured default ceiling of **4288 MB**.

Working hypothesis: worker heap exhaustion, i.e. HARNESS/RESOURCE, not a candidate defect. Control
runs are executing to confirm the same death on trees that never saw the absorb.

## 7. Issues created / Project 86

None yet — no candidate regression proven so far.

## 8. Uncertainties

1. Controls run with the candidate's dependency tree by design (§2). This isolates source bytes but
   would mask a purely dependency-driven difference. None of the clusters proven so far is
   dependency-shaped.
2. The predecessor's original full-suite failure text for §4.4 is unrecoverable.

## 9. Verdict

Pending gateway control completion.
