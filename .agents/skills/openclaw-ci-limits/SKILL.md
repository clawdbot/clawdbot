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
after admission. Canonical `main` is single-flight: one run completes while
GitHub's default single pending slot is replaced by the newest push. Count one
active main matrix plus its next pending matrix, not every intermediate merge.

Reject a change unless the org-level worst case stays below about 60% of the
live bucket. With the current 10,000-registration bucket, keep planned
Blacksmith burst load under 6,000 registrations per 5 minutes with headroom for
ClawSweeper, ClawHub, Clownfish, OpenClaw RTT, and Clawbench.

## Safe Levers

Prefer these in order:

1. Preserve cancel-in-progress for superseded pull-request heads.
2. Preserve canonical `main` single-flight without canceling its running
   integration cycle; GitHub's default pending slot coalesces to the newest tip.
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

- `CI` concurrency key version, PR cancellation, and non-canceling canonical
  `main` single-flight with one coalesced pending tip.
- `preflight` and hosted `security-fast` start immediately without a debounce
  or standalone admission job. On Node-relevant canonical main pushes,
  preflight also owns the sole dependency sticky-disk write and 8 GiB prune
  before fanout; replacement visibility is proved only by a later exact-marker
  restore because Blacksmith snapshot promotion can lag job completion.
- CI matrix caps: fast/check lanes at 12, Node test shards at 28, Windows and
  Android at 2.
- Canonical PR Node tests use one precise changed-target job when possible;
  broad, deleted, unknown, or planner-failed changes fall back to the 14-job
  compact full-suite plan. Targeted plans retain the full built-artifact
  boundary gate. `main`, manual, and release runs stay full.
- `build-artifacts` on `blacksmith-16vcpu-ubuntu-2404`.
- lower-weight Node/check shards on `blacksmith-4vcpu-ubuntu-2404`.
- heavy retained Linux/Android shards on `blacksmith-8vcpu-ubuntu-2404`.
- CodeQL Critical Quality on `ubuntu-24.04` with no `blacksmith-` labels.
- Vitest/test compile caches are restore-only in CI and use immutable Actions
  caches; the daily/dispatch warmer is their sole writer. Build compile cache
  writes rotate at most once per UTC day. PRs create no runtime-cache archives.

When changing one knob, update `docs/ci.md` and the guard test in the same PR.

## Validation

For workflow-only or docs/skill-only changes in a Codex worktree:

```bash
node scripts/run-vitest.mjs test/scripts/ci-workflow-guards.test.ts
node scripts/check-workflows.mjs
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
