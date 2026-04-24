---
summary: "How to run tests locally (vitest) and when to use force/coverage modes"
read_when:
  - Running or fixing tests
title: "Tests"
---

- Full testing kit (suites, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Kills any lingering gateway process holding the default control port, then runs the full Vitest suite with an isolated gateway port so server tests don’t collide with a running instance. Use this when a prior gateway run left port 18789 occupied.
- `pnpm test:coverage`: Runs the unit suite with V8 coverage (via `vitest.unit.config.ts`). This is a loaded-file unit coverage gate, not whole-repo all-file coverage. Thresholds are 70% lines/functions/statements and 55% branches. Because `coverage.all` is false, the gate measures files loaded by the unit coverage suite instead of treating every split-lane source file as uncovered.
- `pnpm test:coverage:changed`: Runs unit coverage only for files changed since `origin/main`.
- `pnpm test:changed`: expands changed git paths into scoped Vitest lanes when the diff only touches routable source/test files. Config/setup changes still fall back to the native root projects run so wiring edits rerun broadly when needed.
- `pnpm changed:lanes`: shows the architectural lanes triggered by the diff against `origin/main`.
- `pnpm check:changed`: runs the smart changed gate for the diff against `origin/main`. It runs core work with core test lanes, extension work with extension test lanes, test-only work with test typecheck/tests only, expands public Plugin SDK or plugin-contract changes to one extension validation pass, and keeps release metadata-only version bumps on targeted version/config/root-dependency checks.
- `pnpm test`: routes explicit file/directory targets through scoped Vitest lanes. Untargeted runs use fixed shard groups and expand to leaf configs for local parallel execution; the extension group always expands to the per-extension shard configs instead of one giant root-project process.
- Full and extension shard runs update local timing data in `.artifacts/vitest-shard-timings.json`; later runs use those timings to balance slow and fast shards. Set `OPENCLAW_TEST_PROJECTS_TIMINGS=0` to ignore the local timing artifact.
- Selected `plugin-sdk` and `commands` test files now route through dedicated light lanes that keep only `test/setup.ts`, leaving runtime-heavy cases on their existing lanes.
- Selected `plugin-sdk` and `commands` helper source files also map `pnpm test:changed` to explicit sibling tests in those light lanes, so small helper edits avoid rerunning the heavy runtime-backed suites.
- `auto-reply` now also splits into three dedicated configs (`core`, `top-level`, `reply`) so the reply harness does not dominate the lighter top-level status/token/helper tests.
- Base Vitest config now defaults to `pool: "threads"` and `isolate: false`, with the shared non-isolated runner enabled across the repo configs.
- `pnpm test:channels` runs `vitest.channels.config.ts`.
- `pnpm test:extensions` and `pnpm test extensions` run all extension/plugin shards. Heavy channel plugins, the browser plugin, and OpenAI run as dedicated shards; other plugin groups stay batched. Use `pnpm test extensions/<id>` for one bundled plugin lane.
- `pnpm test:perf:imports`: enables Vitest import-duration + import-breakdown reporting, while still using scoped lane routing for explicit file/directory targets.
- `pnpm test:perf:imports:changed`: same import profiling, but only for files changed since `origin/main`.
- `pnpm test:perf:changed:bench -- --ref <git-ref>` benchmarks the routed changed-mode path against the native root-project run for the same committed git diff.
- `pnpm test:perf:changed:bench -- --worktree` benchmarks the current worktree change set without committing first.
- `pnpm test:perf:profile:main`: writes a CPU profile for the Vitest main thread (`.artifacts/vitest-main-profile`).
- `pnpm test:perf:profile:runner`: writes CPU + heap profiles for the unit runner (`.artifacts/vitest-runner-profile`).
- `pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json`: runs every full-suite Vitest leaf config serially and writes grouped duration data plus per-config JSON/log artifacts. The Test Performance Agent uses this as its baseline before attempting slow-test fixes.
- `pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json`: compares grouped reports after a performance-focused change.
- Gateway integration: opt-in via `OPENCLAW_TEST_INCLUDE_GATEWAY=1 pnpm test` or `pnpm test:gateway`.
- `pnpm test:e2e`: Runs gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing). Defaults to `threads` + `isolate: false` with adaptive workers in `vitest.e2e.config.ts`; tune with `OPENCLAW_E2E_WORKERS=<n>` and set `OPENCLAW_E2E_VERBOSE=1` for verbose logs.
- `pnpm test:live`: Runs provider live tests (minimax/zai). Requires API keys and `LIVE=1` (or provider-specific `*_LIVE_TEST=1`) to unskip.
- `pnpm test:docker:all`: Builds the shared live-test image and Docker E2E image once, then runs the Docker smoke lanes with `OPENCLAW_SKIP_DOCKER_BUILD=1` at concurrency 8 by default. Tune the main pool with `OPENCLAW_DOCKER_ALL_PARALLELISM=<n>` and the provider-sensitive tail pool with `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM=<n>`; both default to 8. Lane starts are staggered by 2 seconds by default to avoid local Docker daemon create storms; override with `OPENCLAW_DOCKER_ALL_START_STAGGER_MS=<ms>`. The runner stops scheduling new pooled lanes after the first failure unless `OPENCLAW_DOCKER_ALL_FAIL_FAST=0` is set, and each lane has a 120-minute timeout overrideable with `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`. Per-lane logs are written under `.artifacts/docker-tests/<run-id>/`.
- `pnpm test:docker:openwebui`: Starts Dockerized OpenClaw + Open WebUI, signs in through Open WebUI, checks `/api/models`, then runs a real proxied chat through `/api/chat/completions`. Requires a usable live model key (for example OpenAI in `~/.profile`), pulls an external Open WebUI image, and is not expected to be CI-stable like the normal unit/e2e suites.
- `pnpm test:docker:mcp-channels`: Starts a seeded Gateway container and a second client container that spawns `openclaw mcp serve`, then verifies routed conversation discovery, transcript reads, attachment metadata, live event queue behavior, outbound send routing, and Claude-style channel + permission notifications over the real stdio bridge. The Claude notification assertion reads the raw stdio MCP frames directly so the smoke reflects what the bridge actually emits.

## Local PR gate

For local PR land/gate checks, run:

- `pnpm check:changed`
- `pnpm check`
- `pnpm check:test-types`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

If `pnpm test` flakes on a loaded host, rerun once before treating it as a regression, then isolate with `pnpm test <path/to/test>`. For memory-constrained hosts, use:

- `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`
- `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache pnpm test:changed`

## Model latency bench (local keys)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Usage:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Optional env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Default prompt: “Reply with a single word: ok. No punctuation or extra text.”

Last run (2025-12-31, 20 runs):

- minimax median 1279ms (min 1114, max 2431)
- opus median 2454ms (min 1224, max 3170)

## CLI startup bench

Script: [`scripts/bench-cli-startup.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-cli-startup.ts)

Usage:

- `pnpm test:startup:bench`
- `pnpm test:startup:bench:smoke`
- `pnpm test:startup:bench:save`
- `pnpm test:startup:bench:update`
- `pnpm test:startup:bench:check`
- `pnpm tsx scripts/bench-cli-startup.ts`
- `pnpm tsx scripts/bench-cli-startup.ts --runs 12`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --case gatewayStatus --runs 3`
- `pnpm tsx scripts/bench-cli-startup.ts --entry openclaw.mjs --entry-secondary dist/entry.js --preset all`
- `pnpm tsx scripts/bench-cli-startup.ts --preset all --output .artifacts/cli-startup-bench-all.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case gatewayStatusJson --output .artifacts/cli-startup-bench-smoke.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --cpu-prof-dir .artifacts/cli-cpu`
- `pnpm tsx scripts/bench-cli-startup.ts --json`

Presets:

- `startup`: `--version`, `--help`, `health`, `health --json`, `status --json`, `status`
- `real`: `health`, `status`, `status --json`, `sessions`, `sessions --json`, `agents list --json`, `gateway status`, `gateway status --json`, `gateway health --json`, `config get gateway.port`
- `all`: both presets

Output includes `sampleCount`, avg, p50, p95, min/max, exit-code/signal distribution, and max RSS summaries for each command. Optional `--cpu-prof-dir` / `--heap-prof-dir` writes V8 profiles per run so timing and profile capture use the same harness.

Saved output conventions:

- `pnpm test:startup:bench:smoke` writes the targeted smoke artifact at `.artifacts/cli-startup-bench-smoke.json`
- `pnpm test:startup:bench:save` writes the full-suite artifact at `.artifacts/cli-startup-bench-all.json` using `runs=5` and `warmup=1`
- `pnpm test:startup:bench:update` refreshes the checked-in baseline fixture at `test/fixtures/cli-startup-bench.json` using `runs=5` and `warmup=1`

Checked-in fixture:

- `test/fixtures/cli-startup-bench.json`
- Refresh with `pnpm test:startup:bench:update`
- Compare current results against the fixture with `pnpm test:startup:bench:check`

## Onboarding E2E (Docker)

Docker is optional; this is only needed for containerized onboarding smoke tests.

Full cold-start flow in a clean Linux container:

```bash
scripts/e2e/onboard-docker.sh
```

This script drives the interactive wizard via a pseudo-tty, verifies config/workspace/session files, then starts the gateway and runs `openclaw health`.

## QR import smoke (Docker)

Ensures the maintained QR runtime helper loads under the supported Docker Node runtimes (Node 24 default, Node 22 compatible):

```bash
pnpm test:docker:qr
```

## Related

- [Testing](/help/testing)
- [Testing live](/help/testing-live)
