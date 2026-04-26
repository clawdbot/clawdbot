---
summary: "CI job graph, scope gates, and local command equivalents"
title: CI pipeline
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only unrelated areas changed.

QA Lab has dedicated CI lanes outside the main smart-scoped workflow. The
`Parity gate` workflow runs on matching PR changes and manual dispatch; it
builds the private QA runtime and compares the mock GPT-5.5 and Opus 4.6
agentic packs. The `QA-Lab - All Lanes` workflow runs nightly on `main` and on
manual dispatch; it fans out the mock parity gate, live Matrix lane, and live
Telegram lane as parallel jobs. The live jobs use the `qa-live-shared`
environment, and the Telegram lane uses Convex leases. `OpenClaw Release
Checks` also runs the same QA Lab lanes before release approval.

The `Duplicate PRs After Merge` workflow is a manual maintainer workflow for
post-land duplicate cleanup. It defaults to dry-run and only closes explicitly
listed PRs when `apply=true`. Before mutating GitHub, it verifies that the
landed PR is merged and that each duplicate has either a shared referenced issue
or overlapping changed hunks.

The `Docs Agent` workflow is an event-driven Codex maintenance lane for keeping
existing docs aligned with recently landed changes. It has no pure schedule: a
successful non-bot push CI run on `main` can trigger it, and manual dispatch can
run it directly. Workflow-run invocations skip when `main` has moved on or when
another non-skipped Docs Agent run was created in the last hour. When it runs, it
reviews the commit range from the previous non-skipped Docs Agent source SHA to
current `main`, so one hourly run can cover all main changes accumulated since
the last docs pass.

The `Test Performance Agent` workflow is an event-driven Codex maintenance lane
for slow tests. It has no pure schedule: a successful non-bot push CI run on
`main` can trigger it, but it skips if another workflow-run invocation already
ran or is running that UTC day. Manual dispatch bypasses that daily activity
gate. The lane builds a full-suite grouped Vitest performance report, lets Codex
make only small coverage-preserving test performance fixes instead of broad
refactors, then reruns the full-suite report and rejects changes that reduce the
passing baseline test count. If the baseline has failing tests, Codex may fix
only obvious failures and the after-agent full-suite report must pass before
anything is committed. When `main` advances before the bot push lands, the lane
rebases the validated patch, reruns `pnpm check:changed`, and retries the push;
conflicting stale patches are skipped. It uses GitHub-hosted Ubuntu so the Codex
action can keep the same drop-sudo safety posture as the docs agent.

```bash
gh workflow run duplicate-after-merge.yml \
  -f landed_pr=70532 \
  -f duplicate_prs='70530,70592' \
  -f apply=true
```

## Job Overview

| Job                              | Purpose                                                                                      | When it runs                         |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `preflight`                      | Detect docs-only changes, changed scopes, changed extensions, and build the CI manifest      | Always on non-draft pushes and PRs   |
| `security-scm-fast`              | Private key detection and workflow audit via `zizmor`                                        | Always on non-draft pushes and PRs   |
| `security-dependency-audit`      | Dependency-free production lockfile audit against npm advisories                             | Always on non-draft pushes and PRs   |
| `security-fast`                  | Required aggregate for the fast security jobs                                                | Always on non-draft pushes and PRs   |
| `build-artifacts`                | Build `dist/`, Control UI, built-artifact checks, and reusable downstream artifacts          | Node-relevant changes                |
| `checks-fast-core`               | Fast Linux correctness lanes such as bundled/plugin-contract/protocol checks                 | Node-relevant changes                |
| `checks-fast-contracts-channels` | Sharded channel contract checks with a stable aggregate check result                         | Node-relevant changes                |
| `checks-node-extensions`         | Full bundled-plugin test shards across the extension suite                                   | Node-relevant changes                |
| `checks-node-core-test`          | Core Node test shards, excluding channel, bundled, contract, and extension lanes             | Node-relevant changes                |
| `extension-fast`                 | Focused tests for only the changed bundled plugins                                           | Pull requests with extension changes |
| `check`                          | Sharded main local gate equivalent: prod types, lint, guards, test types, and strict smoke   | Node-relevant changes                |
| `check-additional`               | Architecture, boundary, extension-surface guards, package-boundary, and gateway-watch shards | Node-relevant changes                |
| `build-smoke`                    | Built-CLI smoke tests and startup-memory smoke                                               | Node-relevant changes                |
| `checks`                         | Verifier for built-artifact channel tests plus push-only Node 22 compatibility               | Node-relevant changes                |
| `check-docs`                     | Docs formatting, lint, and broken-link checks                                                | Docs changed                         |
| `skills-python`                  | Ruff + pytest for Python-backed skills                                                       | Python-skill-relevant changes        |
| `checks-windows`                 | Windows-specific test lanes                                                                  | Windows-relevant changes             |
| `macos-node`                     | macOS TypeScript test lane using the shared built artifacts                                  | macOS-relevant changes               |
| `macos-swift`                    | Swift lint, build, and tests for the macOS app                                               | macOS-relevant changes               |
| `android`                        | Android unit tests for both flavors plus one debug APK build                                 | Android-relevant changes             |
| `test-performance-agent`         | Daily Codex slow-test optimization after trusted activity                                    | Main CI success or manual dispatch   |

## Fail-fast order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs.
2. `security-scm-fast`, `security-dependency-audit`, `security-fast`, `check`, `check-additional`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs.
3. `build-artifacts` overlaps with the fast Linux lanes so downstream consumers can start as soon as the shared build is ready.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-channels`, `checks-node-extensions`, `checks-node-core-test`, PR-only `extension-fast`, `checks`, `checks-windows`, `macos-node`, `macos-swift`, and `android`.

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`.
CI workflow edits validate the Node CI graph plus workflow linting, but do not force Windows, Android, or macOS native builds by themselves; those platform lanes stay scoped to platform source changes.
CI routing-only edits, selected cheap core-test fixture edits, and narrow plugin contract helper/test-routing edits use a fast Node-only manifest path: preflight, security, and a single `checks-fast-core` task. That path avoids build artifacts, Node 22 compatibility, channel contracts, full core shards, bundled-plugin shards, and additional guard matrices when the changed files are limited to the routing or helper surfaces that the fast task exercises directly.
Windows Node checks are scoped to Windows-specific process/path wrappers, npm/pnpm/UI runner helpers, package manager config, and the CI workflow surfaces that execute that lane; unrelated source, plugin, install-smoke, and test-only changes stay on the Linux Node lanes so they do not reserve a 16-vCPU Windows worker for coverage that is already exercised by the normal test shards.
The separate `install-smoke` workflow reuses the same scope script through its own `preflight` job. It splits smoke coverage into `run_fast_install_smoke` and `run_full_install_smoke`. Pull requests run the fast path for Docker/package surfaces, bundled plugin package/manifest changes, and core plugin/channel/gateway/Plugin SDK surfaces that the Docker smoke jobs exercise. Source-only bundled plugin changes, test-only edits, and docs-only edits do not reserve Docker workers. The fast path builds the root Dockerfile image once, checks the CLI, runs the agents delete shared-workspace CLI smoke, runs the container gateway-network e2e, verifies a bundled extension build arg, and runs the bounded bundled-plugin Docker profile under a 240-second aggregate command timeout with each scenario's Docker run capped separately. The full path keeps QR package install and installer Docker/update coverage for nightly scheduled runs, manual dispatches, workflow-call release checks, and pull requests that truly touch installer/package/Docker surfaces. `main` pushes, including merge commits, do not force the full path; when changed-scope logic would request full coverage on a push, the workflow keeps the fast Docker smoke and leaves the full install smoke to nightly or release validation. The slow Bun global install image-provider smoke is separately gated by `run_bun_global_install_smoke`; it runs on the nightly schedule and from the release checks workflow, and manual `install-smoke` dispatches can opt into it, but pull requests and `main` pushes do not run it. QR and installer Docker tests keep their own install-focused Dockerfiles. Local `test:docker:all` prebuilds one shared live-test image and one shared `scripts/e2e/Dockerfile` built-app image, then runs the live/E2E smoke lanes with a weighted scheduler and `OPENCLAW_SKIP_DOCKER_BUILD=1`; tune the default main-pool slot count of 10 with `OPENCLAW_DOCKER_ALL_PARALLELISM` and the provider-sensitive tail-pool slot count of 10 with `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM`. Heavy lane caps default to `OPENCLAW_DOCKER_ALL_LIVE_LIMIT=6`, `OPENCLAW_DOCKER_ALL_NPM_LIMIT=8`, and `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT=7` so npm install and multi-service lanes do not overcommit Docker while lighter lanes still fill available slots. Lane starts are staggered by 2 seconds by default to avoid local Docker daemon create storms; override with `OPENCLAW_DOCKER_ALL_START_STAGGER_MS=0` or another millisecond value. The local aggregate preflights Docker, removes stale OpenClaw E2E containers, emits active-lane status, persists lane timings for longest-first ordering, and supports `OPENCLAW_DOCKER_ALL_DRY_RUN=1` for scheduler inspection. It stops scheduling new pooled lanes after the first failure by default, and each lane has a 120-minute fallback timeout overrideable with `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`; selected live/tail lanes use tighter per-lane caps. The reusable live/E2E workflow mirrors the shared-image pattern by building and pushing one SHA-tagged GHCR Docker E2E image before the Docker matrix, then running the matrix with `OPENCLAW_SKIP_DOCKER_BUILD=1`. The scheduled live/E2E workflow runs the full release-path Docker suite daily. The bundled update matrix is split by update target so repeated npm update and doctor repair passes can shard with other bundled checks.

Local changed-lane logic lives in `scripts/changed-lanes.mjs` and is executed by `scripts/check-changed.mjs`. That local gate is stricter about architecture boundaries than the broad CI platform scope: core production changes run core prod typecheck plus core tests, core test-only changes run only core test typecheck/tests, extension production changes run extension prod typecheck plus extension tests, and extension test-only changes run only extension test typecheck/tests. Public Plugin SDK or plugin-contract changes expand to extension validation because extensions depend on those core contracts. Release metadata-only version bumps run targeted version/config/root-dependency checks. Unknown root/config changes fail safe to all lanes.

On pushes, the `checks` matrix adds the push-only `compat-node22` lane. On pull requests, that lane is skipped and the matrix stays focused on the normal test/channel lanes.

The slowest Node test families are split or balanced so each job stays small without over-reserving runners: channel contracts run as three weighted shards, bundled plugin tests balance across six extension workers, small core unit lanes are paired, auto-reply runs as four balanced workers with the reply subtree split into agent-runner, dispatch, and commands/state-routing shards, and agentic gateway/plugin configs are spread across the existing source-only agentic Node jobs instead of waiting on built artifacts. Broad browser, QA, media, and miscellaneous plugin tests use their dedicated Vitest configs instead of the shared plugin catch-all. Extension shard jobs run up to two plugin config groups at a time with one Vitest worker per group and a larger Node heap so import-heavy plugin batches do not create extra CI jobs. The broad agents lane uses the shared Vitest file-parallel scheduler because it is import/scheduling dominated rather than owned by a single slow test file. `runtime-config` runs with the infra core-runtime shard to keep the shared runtime shard from owning the tail. Include-pattern shards record timing entries using the CI shard name, so `.artifacts/vitest-shard-timings.json` can distinguish a whole config from a filtered shard. `check-additional` keeps package-boundary compile/canary work together and separates runtime topology architecture from gateway watch coverage; the boundary guard shard runs its small independent guards concurrently inside one job. Gateway watch, channel tests, and the core support-boundary shard run concurrently inside `build-artifacts` after `dist/` and `dist-runtime/` are already built, keeping their old check names as lightweight verifier jobs while avoiding two extra Blacksmith workers and a second artifact-consumer queue.
Android CI runs both `testPlayDebugUnitTest` and `testThirdPartyDebugUnitTest`, then builds the Play debug APK. The third-party flavor has no separate source set or manifest; its unit-test lane still compiles that flavor with the SMS/call-log BuildConfig flags, while avoiding a duplicate debug APK packaging job on every Android-relevant push.
`extension-fast` is PR-only because push runs already execute the full bundled plugin shards. That keeps changed-plugin feedback for reviews without reserving an extra Blacksmith worker on `main` for coverage already present in `checks-node-extensions`.

GitHub may mark superseded jobs as `cancelled` when a newer push lands on the same PR or `main` ref. Treat that as CI noise unless the newest run for the same ref is also failing. Aggregate shard checks use `!cancelled() && always()` so they still report normal shard failures but do not queue after the whole workflow has already been superseded.
The CI concurrency key is versioned (`CI-v7-*`) so a GitHub-side zombie in an old queue group cannot indefinitely block newer main runs.

## Runners

| Runner                           | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`                   | `preflight`, fast security jobs and aggregates (`security-scm-fast`, `security-dependency-audit`, `security-fast`), fast protocol/contract/bundled checks, sharded channel contract checks, `check` shards except lint, `check-additional` shards and aggregates, Node test aggregate verifiers, docs checks, Python skills, workflow-sanity, labeler, auto-response; install-smoke preflight also uses GitHub-hosted Ubuntu so the Blacksmith matrix can queue earlier |
| `blacksmith-8vcpu-ubuntu-2404`   | `build-artifacts`, build-smoke, Linux Node test shards, bundled plugin test shards, `android`                                                                                                                                                                                                                                                                                                                                                                           |
| `blacksmith-16vcpu-ubuntu-2404`  | `check-lint`, which remains CPU-sensitive enough that 8 vCPU cost more than it saved; install-smoke Docker builds, where 32-vCPU queue time cost more than it saved                                                                                                                                                                                                                                                                                                     |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blacksmith-6vcpu-macos-latest`  | `macos-node` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `blacksmith-12vcpu-macos-latest` | `macos-swift` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                 |

## Local Equivalents

```bash
pnpm changed:lanes   # inspect the local changed-lane classifier for origin/main...HEAD
pnpm check:changed   # smart local gate: changed typecheck/lint/tests by boundary lane
pnpm check          # fast local gate: production tsgo + sharded lint + parallel fast guards
pnpm check:test-types
pnpm check:timed    # same gate with per-stage timings
pnpm build:strict-smoke
pnpm check:architecture
pnpm test:gateway:watch-regression
pnpm test           # vitest tests
pnpm test:channels
pnpm test:contracts:channels
pnpm check:docs     # docs format + lint + broken links
pnpm build          # build dist when CI artifact/build-smoke lanes matter
pnpm ci:timings                               # summarize the latest origin/main push CI run
pnpm ci:timings:recent                        # compare recent successful main CI runs
node scripts/ci-run-timings.mjs <run-id>      # summarize wall time, queue time, and slowest jobs
node scripts/ci-run-timings.mjs --latest-main # ignore issue/comment noise and choose origin/main push CI
node scripts/ci-run-timings.mjs --recent 10   # compare recent successful main CI runs
pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json
pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json
```

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
