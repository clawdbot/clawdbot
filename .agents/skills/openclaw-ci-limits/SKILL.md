---
name: openclaw-ci-limits
description: Manage OpenClaw GitHub Actions and Blacksmith CI capacity, runner-registration budgets, fanout caps, main-push debounce, shard sizing, hosted-runner offload, queue health, and safe ramp-down/ramp-up changes. Use when tuning `.github/workflows/*`, `docs/ci.md`, CI runner labels, matrix `max-parallel`, ClawSweeper/Blacksmith burst protection, CodeQL runner placement, or investigating slow/queued OpenClaw CI.
---

# OpenClaw CI Limits

Use this skill for CI capacity changes, not ordinary test failure triage. The
goal is to keep OpenClaw fast while staying below GitHub's self-hosted runner
registration edge limit.

## Core Facts

- The scarce resource is Blacksmith runner registrations, not Blacksmith vCPU
  capacity.
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
curl -fsS https://clawsweeper.openclaw.ai/api/status | jq '{generated_at,fleet,diagnostics:{errors:.diagnostics.errors}}'
curl -fsS https://clawsweeper.openclaw.ai/api/exact-review-queue | jq '.'
node scripts/ci-run-timings.mjs --latest-main
node scripts/ci-run-timings.mjs --recent 10
```

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
- **OpenClaw test runtime:** jobs start quickly but one lane dominates wall time.
  Use `$openclaw-test-performance` instead of runner tuning.
- **Real failing CI:** one job fails after starting. Use `$github:gh-fix-ci` or
  `$openclaw-testing`, not this skill.
- **ClawSweeper backlog:** exact-review queue grows while CI is healthy. Tune
  ClawSweeper workers in `openclaw/clawsweeper`, not OpenClaw CI.

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

For repeated pushes, multiply by the number of runs expected to reach
Blacksmith admission in the same 5-minute window, including runs canceled after
admission. The debounce only suppresses pushes that arrive while
`runner-admission` is still sleeping; once Blacksmith jobs register, those
registrations are spent even if a later push cancels the run. If timing is
uncertain, count every sequential push in the window.

Reject a change unless the org-level worst case stays below about 60% of the
live bucket. With the current 10,000-registration bucket, keep planned
Blacksmith burst load under 6,000 registrations per 5 minutes with headroom for
ClawSweeper, ClawHub, Clownfish, OpenClaw RTT, and Clawbench.

## Safe Levers

Prefer these in order:

1. Add or preserve concurrency groups that cancel superseded PR and canonical
   `main` runs before Blacksmith work starts.
2. Keep the `runner-admission` hosted debounce for canonical `main` pushes.
   Change `OPENCLAW_MAIN_CI_DEBOUNCE_SECONDS` only with evidence.
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
- treat cancelled superseded runs as failures without checking the newest run
  for the same ref.

## Current OpenClaw Knobs

These are intentionally guarded by `test/scripts/ci-workflow-guards.test.ts`:

- `CI` concurrency key version and `cancel-in-progress` for PRs and canonical
  `main` pushes.
- `runner-admission` on `ubuntu-24.04` with
  `OPENCLAW_MAIN_CI_DEBOUNCE_SECONDS=90`.
- `preflight` and `security-fast` needing `runner-admission`.
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
- ClawSweeper queue pending, dispatching, leased, oldest pending age;
- any real failures that remain outside runner registration.
