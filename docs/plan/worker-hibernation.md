---
summary: Design note for a hibernation tier for worker environments — checkpoint-based warm start via Crabbox, with dormant leases and serverless backends as gated follow-ups.
title: Worker hibernation plan
read_when:
  - Designing or reviewing cloud worker idle cost, warm start, or snapshot lifecycle
  - Changing the crabbox provider's provision/teardown flow or the WorkerProvider capability surface
---

## Status

Accepted 2026-08-26 (maintainer: "build live test document PR land"). Phase 1
is implemented in `extensions/crabbox/` and live-proven; phases 2 and 3 remain
gated as designed. Written from direct source inspection of this repo and the
sibling `openclaw/crabbox` checkout (`../crabbox` @ 19bd2f51).

Live proof (2026-08-26, isolated dev gateway, Crabbox dev build with the
fixed-ID fork contract):

- Local-container backend, full loop: cold dispatch → `active` in 101s;
  reclaim ran scrub + `checkpoint create` (docker-commit) in a 37s teardown;
  warm dispatch forked the checkpoint to `active` in **40s (2.5x faster)**.
  Fork proven by container image ancestry (worker container ran the exact
  checkpoint-commit image), preinstalled CLI reuse, and zero fallback
  warnings. A second reclaim skipped capture because a fresh image existed
  (single-flight/dedupe path). Scrub boundary verified: the captured image
  contains no `~/.openclaw/cloud-workers` (no node identity, device token,
  bundles, or workspace bytes).
- AWS via managed Crabbox coordinator: two cold dispatches to `active` (221s,
  311s) through real EC2 + node enrollment; capture correctly degraded to
  cold-only with one warning and teardown proceeded — coordinator-brokered
  native checkpoint creation is admin-token-gated in Crabbox today (see
  follow-ups). All leases and checkpoints were cleaned; zero orphans.

Live findings folded back into the code: capture phases need a 180s budget
(60s starves a real `crabbox run`/snapshot round trip under coordinator
latency). Rig traps recorded for operators: unreleased Gateway builds need the
exact locally packed version installed by `setup` (npm >= 11.16 quarantines
install scripts for URL tarballs — install with `--ignore-scripts` to a
prefix; stock Ubuntu AMIs with root umask 077 need `chmod -R a+rX` after
`sudo npm install`).

Follow-ups (upstream `openclaw/crabbox`): allow owner-scoped native checkpoint
create/fork on coordinator-brokered leases (today the image API requires
`broker.adminToken`, so warm images on managed-coordinator profiles degrade to
cold-only); investigate the fresh-AWS-lease early-reboot window that kills the
first `crabbox run` shortly after warmup reports ready.

## Problem

Cloud worker placements are all-or-nothing. While a session is placed, the
Gateway heartbeats the lease (`extensions/crabbox/src/crabbox-worker-heartbeat.ts`)
and the machine bills continuously. When the session stops — explicit
**Stop cloud worker**, archive, move, or failure — the placement teardown
destroys the environment (`src/gateway/worker-environments/placement-dispatch.ts:539`)
and `crabbox stop` releases the machine (AWS: `TerminateInstances`,
`../crabbox/internal/cli/aws.go:876`). The next turn on a reclaimed placement
always redispatches a brand-new machine
(`src/gateway/worker-environments/reclaimed-placement-redispatch.ts`); there is
no warm-lease reuse anywhere — environment ids are derived from the dispatch
idempotency key, which includes the placement generation
(`src/gateway/worker-environments/placement-dispatch.ts:266-268`), so every
dispatch maps to a fresh environment by construction.

The cold path that fresh machine pays, per dispatch:

1. `crabbox warmup` allocation (minutes; 5m + 20m envelope per attempt,
   `extensions/crabbox/src/crabbox-worker-timeouts.ts:7`).
2. Profile `setup` — typically a Node.js install (15m budget,
   `crabbox-worker-timeouts.ts:31`).
3. Node enrollment, whose script `npx`-fetches the full `openclaw` package from
   the registry (`extensions/crabbox/src/crabbox-worker-node-enrollment.ts:94-100`)
   — the dominant fresh-box cost — plus, for Codex, the platform-native
   `@openclaw/codex` verification (`:41-77`).
4. Gateway bundle push (content-addressed; ~240 MB scale envelope,
   `src/gateway/worker-environments/bootstrap.ts:55`).
5. Workspace sync.

Hosted competitors (Hermes Agent's Modal/Daytona terminal backends, Codex
cloud's container-state cache, Claude Code on the web's post-setup snapshot)
park a sandbox at near-zero idle cost and resume it warm.
`docs/plan/cloud-workers.md:210` already names "image snapshot after bootstrap"
as the v2 fast-start path; this note designs it. (The task brief cited
`docs/start/why-openclaw.md` "Sleeping rented compute" — that page does not
exist in-tree; the gap statement here stands on code evidence only.)

## Current behavior — evidence map

| Fact                                                                                                                                                                              | Where                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider contract is provision/inspect/destroy + optional `renew` (never called by any production code)                                                                           | `src/plugins/capability-provider.types.ts:192-232`; no `provider.renew` call site repo-wide                                                                                                                     |
| `WorkerLeaseStatus` already has `dormant`; lifecycle holds dormant records without orphaning                                                                                      | `src/plugins/capability-provider.types.ts:136-144`; `src/gateway/worker-environments/provider-lifecycle.ts:489-496`                                                                                             |
| Only the device provider returns `dormant` (paired-but-offline, 14-day ceiling)                                                                                                   | `src/gateway/worker-environments/device-provider.ts:153-164,21`                                                                                                                                                 |
| Crabbox maps `stopped`/`stopped_with_code` to `destroyed` — a stopped-with-disk lease would be reaped as proven teardown today                                                    | `extensions/crabbox/src/crabbox-worker-provider.ts:67-76,693-712`                                                                                                                                               |
| A new environment state is a SQLite CHECK-constraint rebuild + schema bump (v10→v11) + protocol + UI enum changes                                                                 | `src/state/openclaw-state-schema.sql:2056-2070`; `src/state/openclaw-state-db-contract.ts:10`; `packages/gateway-protocol/src/schema/environments.ts:22-34`; `src/gateway/server-methods/environments.ts:46-58` |
| No idle/TTL policy exists in core; lifetime is provider-owned (`settings.ttl`/`idleTimeout` → Crabbox flags + heartbeat)                                                          | `src/config/zod-schema.cloud-workers.ts:60-73`; `extensions/crabbox/src/crabbox-worker-profile.ts:131-135,305-308`                                                                                              |
| Docker sandboxes already do stop→start resume, and prune (24h idle / 7d age) removes the container but keeps the bind-mounted workspace                                           | `src/agents/sandbox/docker.ts:688`; `src/agents/sandbox/constants.ts:18-19`; `src/agents/sandbox/docker-backend.ts:253-258`                                                                                     |
| SSH bootstrap has a receipt fast path; enrollment script short-circuits on a live pid — a _running_ box already resumes near-free. The gap is exclusively the stopped/parked case | `src/gateway/worker-environments/bootstrap.ts:266-274`; `crabbox-worker-node-enrollment.ts:85`                                                                                                                  |

## Dependency contract — Crabbox (inspected at `../crabbox`)

Crabbox already ships the hibernation primitives; OpenClaw just doesn't use
them:

- **Checkpoints**: `crabbox checkpoint create|list|inspect|restore|fork|delete|prune`
  (`internal/cli/checkpoint.go`). Native kinds: `aws-ebs-snapshot`, `aws-ami`,
  `hetzner-snapshot`, Azure/GCP disk/image, `machine0-image`,
  `parallels-snapshot`, `docker-commit`; plus portable `workspace-archive`.
  `checkpoint fork <chk> --class …` boots a fresh lease from a native snapshot.
  Sources are cleaned with `cloud-init clean --logs` before native capture
  (fresh SSH host keys per fork). Records are two-halved: local metadata +
  provider resource; `inspect --verify --json` audits both (direct AWS/Hetzner
  or via coordinator).
- **Pause/resume**: `crabbox pause|resume` behind a `PausableBackend`
  capability (`internal/cli/provider_backend.go:297-305`) — implemented **only
  by the islo backend** today. The AWS backend has no EC2 stop path at all
  (`DeleteServer` terminates).
- **Serverless backends**: `internal/providers/daytona` (snapshot-based
  sandboxes) and `internal/providers/modal` already exist behind the same
  lease CLI the OpenClaw crabbox plugin drives.
- **Promoted base images**: `crabbox image promote` (coordinator-admin only) —
  account-level default images, complementary but not per-profile.

Gaps to close upstream (small, both repos are ours):

1. **Fixed-ID fork.** Only `warmup`/`run` accept `--lease-id`
   (`internal/cli/run.go:52`); `checkpoint fork` does not. OpenClaw's
   replay-safe provisioning derives a deterministic `cbx_…` lease id from the
   durable operation id and requires the provider to adopt exactly that lease
   on replay (`extensions/crabbox/src/crabbox-worker-profile.ts:407`;
   `docs/gateway/cloud-workers.md:135`). Fork needs the same contract
   (`checkpoint fork --lease-id`, or `warmup --from-checkpoint <chk>`).
2. **`--json` on `checkpoint create`/`fork`** (list/inspect already have it) so
   the plugin parses results structurally instead of scraping lines.

## Directions evaluated

### (a) Dormant cloud lease (stop-with-disk) — defer, with a named trigger

Park the machine stopped, keep the disk, wake on next dispatch. Rejected for
now on three grounds:

- **No provider support where it matters.** Crabbox's `PausableBackend` covers
  only islo; AWS stop-with-disk doesn't exist in Crabbox, and Hetzner bills
  stopped servers at full price (resources stay allocated), so the flagship
  backends yield either no path or no savings. AWS EC2-stop economics
  (EBS-only) are almost identical to an EBS snapshot — which needs no parked
  instance, no reserved capacity, and no held addresses.
- **Largest core surface of the three.** A parked-but-owned lease needs either
  a new environment state (CHECK rebuild, schema v10→v11, protocol + UI enums
  — the maximal persistence change) or delicate reuse of existing states,
  plus park/wake policy that core deliberately doesn't have today (no idle
  machinery, provider-owned lifetime), plus wake-time re-enrollment and
  credential re-arm.
- **Upgrade staleness erodes the value.** A stale Gateway build retires the
  environment and reprovisions rather than downgrading
  (`docs/gateway/cloud-workers.md:154`); any parked box that sleeps across a
  Gateway upgrade is destroyed on wake anyway.

**Trigger to revisit:** a proven backend with genuinely cheap sleep —
Crabbox `PausableBackend` on a big-cloud backend, or a validated
Daytona/Modal profile whose platform auto-stop we want to honor. The
`dormant` lease-status seam and the lifecycle's hold-don't-orphan branch
already exist for it; phase 3 below reserves the slot.

### (b) Checkpoint on teardown + warm-start fork — **chosen**

Maps exactly onto existing Crabbox capability, preserves every identity and
authority invariant by construction (each dispatch still provisions a fresh
lease, fresh enrollment, fresh environment id — nothing about worker
admission, owner epochs, or credential fencing changes), needs **zero core
changes in its first phase**, and its idle cost is snapshot storage
(order €0.01–0.05/GB-month) instead of a live machine.

### (c) Daytona/Modal serverless backend — validation track, not new code

Crabbox already has both backends. The OpenClaw crabbox provider passes
`settings.provider` through; the work is proving the enrolled-node flow on
those platforms (Node.js present or installable, outbound WebSocket egress to
the Gateway, SSH-shaped `crabbox run` for setup), then documenting the
profile. No new `WorkerProvider` implementation is warranted — that would
duplicate the plugin's provider policy in core's back yard. Their native
auto-stop/resume becomes interesting under direction (a)'s trigger.

## Design

### Phase 1 — profile warm images, plugin-only (no core, SDK, schema, or protocol changes)

Owner: the crabbox plugin. Everything below lives in `extensions/crabbox/`.

**Capture (at teardown).** When a profile opts in and no fresh image exists
for the profile's image key, `destroy` — after fencing the heartbeat, before
`crabbox stop` — runs one scrub-and-snapshot step:

1. Scrub via `crabbox run --script-stdin`: stop the node child and remove the
   per-lease state root (`$HOME/.openclaw/cloud-workers/`), which holds the
   node identity, durable device token, worker bundles, and **all workspaces**
   (`docs/gateway/cloud-workers.md:133`). After the scrub the box contains
   only generic profile state: OS + setup results (Node.js), npm/npx caches
   with the exact `openclaw` package, and the Codex platform binary cache.
   No OpenClaw identity, no workspace bytes — safe to share across sessions
   and operators of the same profile. (Server-side, the environment-owned
   pairing is removed at destroy regardless; the scrub is secret minimization,
   not the security boundary.)
2. `crabbox checkpoint create --id <lease> --mode native --wait=false` and
   record the checkpoint id as _pending_. EBS snapshots complete after the
   source terminates, so teardown latency gains only the scrub + initiation,
   not the snapshot wait. Backends where native capture needs the source
   alive (per Crabbox's per-provider rules) either wait bounded or skip
   capture — capture failure never fails teardown.

**Restore (at provision).** `provision` looks up the profile's image record;
if present, verifies availability (`checkpoint inspect --verify --json`), then
forks with the fixed lease id instead of `warmup`. Setup still runs (it is
contractually idempotent and now hits its `command -v` guards); enrollment
still runs fresh (new lease id → new state dir) but resolves the `openclaw`
package from the warm npm cache instead of the registry. Any fork failure
falls back to the cold `warmup` path — never dead-end a dispatch on a
missing, stale, or still-pending snapshot. (Fallback contract: product
behavior per the doctrine, not a compat shim.)

**Image key and staleness.** Record key = hash of (backend provider, profile
`setup`, sorted `setupEnv` names, `desktop`, exact machine class). Exact-class
matching is the accepted conservative decision; cross-class and cross-region
reuse are future work. A key change (edited setup command, backend switch, or
machine class) simply misses the record and cold-provisions; the stale image
ages out.

**Storage.** Plugin KV in the shared state DB (the sanctioned plugin-scratch
store — no new tables, no sidecar files): one record per image key holding
checkpoint id, provider resource id, state (pending/available), created/last
used timestamps. Crabbox's own local checkpoint metadata (its state dir on the
Gateway host) remains the fork-time authority; the KV record is the index.
Single-flight capture per key via compare-and-set so concurrent teardowns
produce at most one snapshot.

**Retention/GC.** On provision and destroy, opportunistically delete
superseded images and images unused for 14 days (matching the device dormancy
ceiling) via `crabbox checkpoint delete`; verify-orphaned records (local half
or provider half missing) are dropped. Provider-side leaks are bounded by
Crabbox's own `checkpoint prune` and crabbox-owned resource tagging.

**Config.** One provider-owned key in the existing `settings` bag —
`settings.warmImage: true` — validated in `crabbox-worker-profile.ts` like
`ttl`/`idleTimeout`. No core config schema change (the bar for new
`openclaw.json` surface stays unmet: provider-owned settings already solve
it). Off by default: warm images create provider-account storage costs and
capture provider-account state, which is an operator spend/trust decision.
Named enablement path: the Cloud workers docs page + config example, and a
`crabbox` doctor/log hint on the first eligible teardown ("enable
settings.warmImage to make the next dispatch warm").

**Cost/latency claim to prove in the PR.** Warm dispatch skips warmup-from-
base-image + Node install + registry fetch; expected minutes → tens of
seconds for the provision-through-enrollment segment on AWS. Live A/B
(cold vs. warm dispatch on the same profile) is the mandatory evidence, per
the live-verify default.

### Phase 2 — per-session hibernation (needs maintainer acceptance; SDK + additive store)

Phase 1 makes the _box_ warm; the reconciled workspace still re-syncs and the
box-local dependency state (installed `node_modules`, build caches — outside
the size-bounded reconcile) is rebuilt by the agent. Phase 2 captures the
machine at reclaim _without_ the workspace scrub (identity still scrubbed),
keyed to the session, so a reclaimed placement's redispatch forks its own
prior state:

- `WorkerProvider` gains an optional capability pair —
  `snapshot?(lease, opts)` / provision `options.restoreFrom` — mirroring how
  `renew?` and `listMachineOptions?` are already optional. Plugin SDK surface:
  additive, registration-validated, no behavior for providers that omit it.
- One additive table (`worker_environment_snapshots`: id, provider, profile,
  session id, snapshot ref JSON, state, created/last-used) in the shared state
  DB — additive-at-same-version by the documented criteria, but flagged here
  because it is persistent-store surface and per AGENTS.md needs explicit
  acceptance before implementation.
- `reclaimed-placement-redispatch` passes the session's snapshot ref into
  dispatch; teardown decides capture per policy. GC by session deletion,
  retention window, and superseded-capture pruning.
- UI: the reclaimed badge can say "resumes warm"; no new placement states.

Phase 2 only starts if phase 1's telemetry shows session redispatch is
frequent enough to justify per-session storage; it is deliberately separable.

### Phase 3 — dormant leases / platform sleep (reserved, gated on the trigger above)

Reuse the `dormant` lease status + lifecycle hold branch; map a genuinely
parked lease (Crabbox pause on a supporting backend, Daytona auto-stop) to
`dormant` instead of `destroyed`; add the wake path. Requires the environment
state-machine and schema discussion — not designed further here until a
backend earns it.

## Validation plan (phase 1)

- Unit: image-key hashing, KV single-flight, fork-vs-warmup selection,
  fallback on fork failure, GC eligibility (crabbox extension tests).
- Live (mandatory): cold dispatch → stop → warm dispatch on a real AWS
  profile; assert the fork path was taken, enrollment succeeded, timings
  recorded; then a stale-image dispatch proving cold fallback. Same-flow proof
  on Hetzner if coordinator checkpoint support verifies.
- Upstream: Crabbox PR for fixed-ID fork + `--json`, with its own e2e.

## Open questions for the maintainer

1. Accept phase 1 as scoped (plugin-only, opt-in `settings.warmImage`)?
2. Default-off confirmed? (Doctrine says defaults are the product; storage
   spend in the operator's provider account argues opt-in. Recommendation:
   opt-in now, revisit default-on once cost surfacing exists.)
3. Retention default 14 days — match device dormancy, or shorter (7d, matching
   terminal-environment row retention)?
4. Is phase 2 wanted at all before demand evidence, given the Gateway already
   owns transcript + reconciled workspace?
5. Green-light the two upstream Crabbox changes?
