---
name: openclaw-ci-limits
description: Manage OpenClaw GitHub Actions and Blacksmith CI capacity, runner-registration budgets, fanout caps, main-push single-flight, shard sizing, hosted-runner offload, queue health, and safe ramp-down/ramp-up changes. Use when tuning `.github/workflows/*`, `docs/ci.md`, CI runner labels, matrix `max-parallel`, ClawSweeper/Blacksmith burst protection, CodeQL runner placement, or investigating slow/queued OpenClaw CI.
---

# OpenClaw CI Limits

Use this skill for CI capacity changes, not ordinary test failure triage. The
goal is to keep OpenClaw fast while distinguishing runner registration, runner
availability, Blacksmith control-plane health, and downstream queue drains.

## Core Facts

- Do not assume the scarce resource. Prove whether pressure is runner
  registrations, eligible runner availability, Blacksmith capacity/control
  plane, workflow dependencies, test runtime, or a downstream queue writer.
- GitHub runner registrations for `openclaw` currently report a 10,000 per
  5-minute bucket in `actions_runner_registration`. Verify the live bucket
  before each tuning pass because GitHub can change it. The `openclaw`
  organization shares one bucket.
- Core REST quota does not draw down this bucket. Check
  `actions_runner_registration` separately; core quota can be healthy while
  runner registration is throttled.
- Use about 60% of the live bucket as the operating target. With the current
  10,000-registration bucket, keep planned Blacksmith burst load under 6,000
  registrations per 5 minutes and leave the rest for other repos, retries, and
  burst overlap.
- Jobs that route, notify, summarize, choose shards, or run short CodeQL quality
  scans should stay on GitHub-hosted runners unless measured evidence says
  Blacksmith is required.

## Rejected Experiments

- **Hosted Mac exact dependencies (2026-09-01):** The same-head publisher and
  consumer in [run 33458856298](https://github.com/openclaw/openclaw/actions/runs/33458856298)
  successfully saved and restored a 1.66-GB dependency archive, but setup took
  142s versus 86s with the ordinary store cache. Extraction took 82s versus 27s;
  install improved only from 43s to 35s. Keep hosted Mac jobs on the ordinary
  store cache. Reconsider only with measured total setup savings, including
  transfer, extraction and frozen reconciliation, not a successful cache hit.
- **Actions-artifact checkout (2026-08-16):** Do not recommend replacing the
  shared Blacksmith Git fetch with a preflight-produced workspace or `.git`
  artifact. [PR #124818](https://github.com/openclaw/openclaw/pull/124818)
  measured a 16s Blacksmith checkout baseline versus 7s hosted. The best direct
  artifact variant cost 1s to pack, 3s to upload, and 11s median to restore;
  including the serial prefix left only about 1s median improvement and
  regressed Blacksmith's fast-fetch runs. The official artifact client was
  worse: [run 31971531521](https://github.com/openclaw/openclaw/actions/runs/31971531521)
  measured 22s median download plus 2s materialization. Blacksmith's fast
  Actions-cache path does not imply fast Actions-artifact downloads. Reconsider
  only with measured end-to-end proof for a different transport, including its
  producer cost and fast-fetch regressions.

## First Checks

Before changing CI, collect current pressure:

```bash
ghx api rate_limit --jq '{core:.resources.core,graphql:.resources.graphql,search:.resources.search,actions_runner_registration:.resources.actions_runner_registration}'
ghx run list -R openclaw/openclaw --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
ghx run list -R openclaw/clawsweeper --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
ghx api repos/openclaw/clawsweeper/actions/runs/<run-id>/jobs --paginate --jq '.jobs[] | {id,name,status,conclusion,labels,created_at,started_at,completed_at,runner_name,runner_group_name}'
blacksmith testbox list --all
curl -fsS https://clawsweeper.openclaw.ai/api/status | jq '{generated_at,fleet,diagnostics:{errors:.diagnostics.errors}}'
curl -fsS https://clawsweeper.openclaw.ai/api/exact-review-queue | jq '{generated_at,review:.lanes.review,publication:.lanes.publication,state_writer,state_append}'
node scripts/ci-run-timings.mjs --latest-main
node scripts/ci-run-timings.mjs --recent 10
```

For a suspicious queued run, inspect its jobs. A run-level `queued` status does
not reveal whether the job is waiting on dependencies or has no eligible
runner. Compare `created_at`, `started_at`, `labels`, and `runner_name`. Recheck
stale queued runs live before canceling them; cancel only runs proven obsolete.

`scripts/ci-run-timings.mjs` start delay can include workflow dependency wait
plus runner queue time. It is trend evidence, not runner-pressure proof alone.

Read:

- `.github/workflows/ci.yml`
- `.github/workflows/codeql-critical-quality.yml`
- `docs/ci.md`
- `test/scripts/ci-workflow-guards.test.ts`
- touched planner files under `scripts/lib/*ci*`, `scripts/lib/*test-plan*`, or
  `scripts/ci-changed-scope.mjs`

## Diagnose The Bottleneck

Classify the issue before changing caps:

- **Runner-registration throttle:** many jobs queued before runner assignment,
  Blacksmith/GitHub reports 403/429 or spam-style 422 responses from
  `generate-jitconfig`, and API core quota is still healthy. Treat 422 as this
  signal only when the request payload is otherwise valid. Fix burstiness and
  Blacksmith job count.
- **Blacksmith capacity:** Blacksmith dashboard shows actual concurrency caps or
  unavailable capacity. Do not solve this with GitHub workflow fanout alone.
- **Blacksmith Testbox control plane:** list, warm, status, or run calls time out
  before a lease is returned. This is separate from Actions runner registration
  and Actions job capacity. Trusted source may use the documented local
  fallback; untrusted source stays blocked.
- **Unavailable runner label:** a job is queued with a custom `runs-on` label,
  `started_at` and `runner_name` remain empty, and no eligible runner exists.
  Restore an available hosted or registered label; fanout cannot fix it.
- **Workflow dependency wait:** the job is queued but required predecessors are
  not terminal. Fix or wait for the dependency; do not call the whole delay
  runner queue pressure.
- **OpenClaw test runtime:** jobs start quickly but one lane dominates wall time.
  Use `$openclaw-test-performance` instead of runner tuning.
- **Real failing CI:** one job fails after starting. Use `$github:gh-fix-ci` or
  `$openclaw-testing`, not this skill.
- **ClawSweeper review backlog:** review pending/ready grows while publication
  and state writers remain healthy. Tune review admission/workers in
  `openclaw/clawsweeper`.
- **ClawSweeper publication backlog:** publication pending/ready and oldest age
  grow, net drain is zero or negative, or dead letters rise. Inspect publication
  batches, state-writer coordination, and GitHub mutation latency first.
- **State materializer/append backlog:** `state_append.pending_rows`,
  `pending_bytes`, or oldest age grows while the materializer is queued or
  absent. Recover that sole drain first; more review workers make it worse.

## Registration Budget Math

Estimate worst-case registrations for a change before editing:

```text
new Blacksmith registrations ~= number of Blacksmith jobs that can become queued
inside one 5 minute window
```

For matrix jobs, count every row that can start in the 5-minute window.
`strategy.max-parallel` only caps simultaneous rows; short rows can turn over
and register more runners before the window resets. Use job duration, retries,
and queue turnover to justify any lower estimate. Add non-matrix Blacksmith jobs
such as `preflight`, `security-fast`, `build-artifacts`, and platform lanes.

For repeated pull-request pushes, multiply by the number of runs expected to
reach Blacksmith admission in the same 5-minute window, including runs canceled
after admission. Canonical `main` uses two run-number-parity slots. Each slot
keeps one active non-canceling run and one coalesced pending tip. Budget for up
to two active main matrices plus their two pending tips entering the next
admission wave, not every intermediate merge.

Reject a change unless the org-level worst case stays below about 60% of the
live bucket. With the current 10,000-registration bucket, keep planned
Blacksmith burst load under 6,000 registrations per 5 minutes with headroom for
ClawSweeper, ClawHub, Clownfish, OpenClaw RTT, and Clawbench.

## Safe Levers

Prefer these in order:

1. Preserve cancel-in-progress for superseded pull-request heads.
2. Preserve canonical `main` as two non-canceling parity slots; each slot's
   default pending run coalesces to the newest tip.
3. Move high-frequency, short, non-build jobs to `ubuntu-24.04`.
4. Reduce matrix rows by bundling related tests inside one runner job when the
   combined job stays under timeout and keeps useful failure names.
5. Lower `strategy.max-parallel` for bursty Blacksmith matrices.
6. Right-size runners from timing evidence. Use fewer/larger jobs only when
   elapsed time improves enough to justify registration count.
7. Split truly slow tests with `$openclaw-test-performance`; do not hide a slow
   test problem by registering more runners.

Do not:

- add another Blacksmith installation expecting a higher registration bucket;
- move CodeQL Critical Quality back to Blacksmith;
- raise all `max-parallel` values at once;
- make manual `workflow_dispatch` runs cancel normal push/PR validation;
- delete coverage just to reduce runner count;
- treat cancelled superseded pull-request runs as failures without checking the
  newest run for the same ref.
- cancel old queued runs from a stale snapshot; re-query the exact run first and
  preserve any current run that still owns live work.

## Current OpenClaw Knobs

These are intentionally guarded by `test/scripts/ci-workflow-guards.test.ts`:

- `CI` concurrency key version, PR cancellation, and canonical `main`'s two
  non-canceling parity slots, each with one coalesced pending tip.
- `preflight` and `security-fast` start immediately without a debounce
  or standalone admission job. The protected `vitest-cache-warm` workflow
  publishes the immutable semantic dependency archive after setup succeeds,
  before build and transform warming. Preflight and downstream Node jobs are
  restore-only consumers on eligible self-hosted runners. Exact misses and
  hosted paths, including Mac Node jobs, use the ordinary pnpm-store cache.
- `ci-gate` always uses `ubuntu-24.04` for its Bash-only result aggregation,
  without checkout or dependency setup. This removes one Blacksmith registration
  from previously eligible runs; hosted assignment can still delay completion.
  `preflight` uses GitHub-hosted Ubuntu in hybrid mode; its logical planner
  profile and cache trust stay unchanged. Default Blacksmith preflight routing
  remains intact. `security-fast` stays hosted outside eligible hybrid first
  attempts. Security hooks use pinned installed packages
  and local hook definitions, without remote Git initialization. The `github`
  outage override remains intact. Budget one control-job registration per eligible
  Blacksmith run or eligible hybrid first attempt.
  The aggregate uses `!cancelled()` to report failed prerequisites without
  holding a superseded run open after workflow cancellation.
- Current fast plugin/channel contract families each share one checkout/setup.
  Their two weighted process envelopes run sequentially with unchanged include
  lists and package commands; channel invocations retain four project slots and
  one worker per project. Any nonzero exit stops admission of the next envelope.
  Frozen targets retain their original separate rows.
- CI matrix caps: fast/check lanes at 12, Node test shards at 96, Windows at 2,
  and Android at 2. Every compact profile has an enforced 80-row budget, plugin
  fallback has a 50-row budget, and the final Node matrix enforces 64 push or
  120 PR rows, including precise plans. Excess inventory fails preflight.
- Windows keeps two disjoint file inventories. Jobs requesting the existing
  Blacksmith class admit at most two project processes with one Vitest worker
  each; hosted fallbacks remain serial. Runtime preparation completes before
  project readers start. Native proof must cover available CPUs/RAM, concurrent
  fixture memory and cleanup. This adds no runner registrations.
- macOS Swift uses two mandatory matrix phases with `max-parallel: 2`:
  release compilation and the complete shared/app test workload. This adds one
  registration per eligible Blacksmith native run: up to four across the two
  active and two pending main slots, plus one for each eligible trusted PR.
  Build caches are phase-owned; only the release phase writes the shared
  SwiftPM dependency cache.
- iOS Release, Debug/simulator tests, and both screenshot shards always use
  `macos-26`. Repeated Blacksmith admission stalls were recovered by the same
  hosted image; do not require a failed first attempt to select that capacity.
  The conservative non-Node inventory, including Control UI performance, is
  86 rows, or 87 for historical UI targets. Excluding those four hosted rows
  and the always-hosted aggregate gate leaves at most 82 potentially eligible jobs.
  The enforced Node caps therefore give 146 registrations per main run and
  202 per PR: `4 × 146 + 21 × 202 = 4,826` in the retained peak arrival
  envelope. The old 19-arrival estimate is obsolete. The remaining 1,174 below
  the 6,000 reference target must cover adjacent repositories, releases and
  carryover; the bounded 2026-09-02 census did not prove that upper bound.
  Treat a single PR concurrency trial separately from a global rollout.
  A shared-token quota response does not establish organization-wide usage.
  Budget all six npm qualification jobs and the actual full-release children;
  ordinary manual check rows can still use Blacksmith outside hybrid mode.
- Canonical PR Node tests use one precise changed-target job when possible;
  broad, deleted or unknown changes fall back to the compact full-suite plan
  plus affected plugin coverage. Current PR planner errors fail preflight.
  Targeted plans retain the full built-artifact
  boundary gate. `main` uses compact integration; manual and release runs use
  full named shards.
- The combined Node matrix admits compact and plugin descriptors by estimated
  duration within the same cap. Catch-all, QA and provider configs use the
  existing 90-file envelope budget with native Vitest sharding; retain complete
  config discovery, exclusions and process isolation. Count every appended
  plugin row, including the five added QA/provider rows, in the burst envelope.
- Plugin fallback groups retain separate child processes, including process-bounded
  configs. Compatible envelopes, including repeated configs, run one at a time
  within 240 predicted seconds without a pair-count limit; expanded serial compact
  jobs use 210. Runtime preparation stays separate. Each original envelope retains
  its file/process bounds, native shard arguments and worker limits. The complete supplemental boundary list runs in one job
  with four concurrent checks and one full-root focused-rule scan.
- Measured Blacksmith chat/session, Gateway core-3 and infrastructure storage/state
  outliers reuse the existing file splitter. Preserve serial execution, worker
  pins and complete timing-history floors; no blanket increase in sharding.
- Blacksmith and hybrid compact bins with multiple ordinary groups request the
  existing 32-vCPU class and two child slots with a 360s aggregate budget.
  Compatible two-slot bins use the time budget without the ten-group cutoff;
  serial bins retain that cutoff. Blacksmith serial bins retain 200/276s, hybrid serial bins retain 210s,
  exclusive bins retain 150s, and groups above their serial cap stay alone.
  Runtime consumers in ordinary bins share preparation only with other consumers;
  hybrid exclusive/dist sharing is unchanged. Complete inventories remain intact.
  The canonical shard executor admits two CI children only with at least eight
  available CPUs and 24 GiB actual memory; otherwise it admits one. Inner project
  parallelism stays one and each overlapping child keeps two Vitest workers.
  The primary GitHub profile remains serial at 210s. Failed-job-only hybrid
  retries retain the original wider matrix on hosted Ubuntu, clamp to one child,
  and keep two workers per child; they can exceed the eight-minute normal-run
  objective without changing existing deadlines. Fewer jobs must retain native
  elapsed-time, actual memory and cleanup proof; requested labels are not capacity.
- The whole Blacksmith agent-support group requests `blacksmith-32vcpu-ubuntu-2404`.
  Its file inventory and resource-derived worker policy remain unchanged.
- Numbered Blacksmith tooling bins request the same 32-vCPU class after packing.
  Keep their logical classes, names, file inventories, serial project/file
  execution and two-worker pins. This adds no jobs and does not promote hosted
  or hybrid tooling. The native two-CPU/8-GB tails require a larger-host timing
  comparison; capacity alone is not a measured speedup.
- The Docker seed job requests `blacksmith-32vcpu-ubuntu-2404`; its weighted
  scheduler and serial declaration compiler policy stay unchanged.
- Eligible Control UI E2E rows request the 32-vCPU class with unchanged live
  backend/event/contributor routing and two/one-worker project limits. Targets
  with the named-project contract use six shards on non-frozen Blacksmith and
  hybrid first attempts; other fresh plans retain twelve. Historical targets without
  that contract retain four total rows on Blacksmith or fourteen on GitHub/hybrid,
  including the browser-extension row. Failed-job-only PR and hybrid push retries
  retain the six-shard width on hosted Ubuntu with the existing 25-minute timeout.
  The browser-extension row stays on 8 and real-Gateway
  on 16. Twelve rows finished by 4:38 in run 33695337496; the reduced width needs
  native timing proof and does not refresh stale timing weights.
- `build-artifacts` on `blacksmith-32vcpu-ubuntu-2404`.
- CPU-heavy test-type, core test-type stripe, runtime-topology, and npm preflight
  jobs request `blacksmith-32vcpu-ubuntu-2404`. The 2026-09-01 x64 probe
  [run 33538827388](https://github.com/openclaw/openclaw/actions/runs/33538827388)
  measured requested 8/16/32 labels delivering 2/4/8 CPUs respectively. Treat
  larger requests as a measured capacity workaround, never as worker counts.
  Keep existing routing, fanout, and resource-based worker limits; reassess
  sizing after provider allocation changes. See `docs/ci.md` for the full table.
- lower-weight Node/check shards on `blacksmith-4vcpu-ubuntu-2404`.
- heavy retained Linux/Android shards on `blacksmith-8vcpu-ubuntu-2404`.
- CodeQL Critical Quality on `ubuntu-24.04` with no `blacksmith-` labels.
- `OPENCLAW_CI_RUNNER_BACKEND=github` routes every configurable `ci.yml` job
  to its existing GitHub-hosted fallback label. Unset or `blacksmith` preserves
  the normal Blacksmith-first route.
- Vitest/test compile caches are restore-only in CI and use immutable Actions
  caches; the daily/dispatch warmer is their sole writer. Build compile cache
  writes rotate at most once per UTC day. PRs create no runtime-cache archives.

When changing one knob, update `docs/ci.md` and the guard test in the same PR.

## Blacksmith Outage Circuit Breaker

Use the repository variable only after confirming a Blacksmith outage or
unavailable runner capacity. Do not set it merely for a failing test that has
already started.

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body github
```

In degraded mode, `ci.yml` uses the same hosted labels and non-Blacksmith paths
as manual dispatches and fork pull requests. Blacksmith-only Docker and sticky
steps stay off, dependency setup uses the ordinary Actions pnpm-store cache,
and Android's large build uses separate low-memory Gradle processes. Standard
4-core hosted runners make builds and test lanes slower. Blacksmith runner
registration is no longer part of the budget, while GitHub-hosted concurrency
limits apply.

Flip back after the outage by deleting the variable:

```bash
gh variable delete OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw
```

Scheduled health detection and automatic flipping are a follow-up, not part of
the current circuit breaker.

## Validation

For workflow-only or docs/skill-only changes in a Codex worktree:

```bash
node scripts/run-vitest.mjs test/scripts/ci-workflow-guards.test.ts
node --import tsx scripts/check-workflows.mts
node scripts/docs-list.js
./node_modules/.bin/oxfmt --check .github/workflows/ci.yml .github/workflows/codeql-critical-quality.yml docs/ci.md test/scripts/ci-workflow-guards.test.ts .agents/skills/openclaw-ci-limits/SKILL.md .agents/skills/openclaw-ci-limits/agents/openai.yaml
git diff --check
```

If `pnpm docs:list` tries to reconcile dependencies in a linked Codex worktree,
stop and use `node scripts/docs-list.js`.

For a PR before requesting maintainer approval:

```bash
.agents/skills/autoreview/scripts/autoreview --mode branch --base origin/main
ghx pr checks <pr> -R openclaw/openclaw --watch --interval 15
```

Use hosted exact-head gates for CI workflow tuning. Do not burn local
`pnpm test` on unrelated full-suite proof.

Only after the maintainer explicitly asks you to prepare or land the PR, run the
repo-native mutating wrapper:

```bash
scripts/pr review-init <pr>
scripts/pr review-artifacts-init <pr>
scripts/pr review-validate-artifacts <pr>
OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>
```

`prepare-run` can push a prepared commit to the PR branch. Only run
`scripts/pr merge-run <pr>` after the maintainer has explicitly asked you to
land the PR. Both commands mutate GitHub state.

## Post-Land Monitoring

After merge, watch at least one fresh main cycle and the adjacent repos:

```bash
ghx run list -R openclaw/openclaw --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
for repo in openclaw/clawsweeper openclaw/clawhub openclaw/clownfish openclaw/openclaw-rtt openclaw/clawbench; do
  ghx run list -R "$repo" --limit 12 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
done
curl -fsS https://clawsweeper.openclaw.ai/api/exact-review-queue | jq '.'
```

Report:

- exact PR/commit landed;
- expected registration reduction or added headroom;
- CI run status and slowest/queued jobs;
- queued job labels, runner assignment, and dependency state for any outlier;
- Blacksmith Actions runner evidence separately from Testbox control-plane
  health;
- ClawSweeper queue pending, dispatching, leased, oldest pending age;
- publication net drain/dead letters, state-writer queued/waiting, and state
  append rows/bytes/oldest item;
- any real failures that remain outside runner registration.
