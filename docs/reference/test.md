---
summary: "How to run tests locally (vitest) and when to use force/coverage modes"
read_when:
  - Running or fixing tests
title: "Tests"
---

- Full testing kit (suites, live, Docker): [Testing](/help/testing)
- Update and plugin package validation: [Testing updates and plugins](/help/testing-updates-plugins)

- `pnpm test:force`: Kills any lingering gateway process holding the default control port, then runs the full Vitest suite with an isolated gateway port so server tests don’t collide with a running instance. Use this when a prior gateway run left port 18789 occupied.
- `pnpm test:coverage`: Runs the unit suite with V8 coverage (via `vitest.unit.config.ts`). This is a loaded-file unit coverage gate, not whole-repo all-file coverage. Thresholds are 70% lines/functions/statements and 55% branches. Because `coverage.all` is false, the gate measures files loaded by the unit coverage suite instead of treating every split-lane source file as uncovered.
- `pnpm test:coverage:changed`: Runs unit coverage only for files changed since `origin/main`.
- `pnpm test:changed`: cheap smart changed test run. It runs precise targets from direct test edits, sibling `*.test.ts` files, explicit source mappings, and the local import graph. Broad/config/package changes are skipped unless they map to precise tests.
- `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed`: explicit broad changed test run. Use it when a test harness/config/package edit should fall back to Vitest's broader changed-test behavior.
- `pnpm changed:lanes`: shows the architectural lanes triggered by the diff against `origin/main`.
- `pnpm check:changed`: runs the smart changed check gate for the diff against `origin/main`. It runs typecheck, lint, and guard commands for the affected architectural lanes, but does not run Vitest tests. Use `pnpm test:changed` or explicit `pnpm test <target>` for test proof.
- `pnpm test`: routes explicit file/directory targets through scoped Vitest lanes. Untargeted runs use fixed shard groups and expand to leaf configs for local parallel execution; the extension group always expands to the per-extension shard configs instead of one giant root-project process.
- Test wrapper runs end with a short `[test] passed|failed|skipped ... in ...` summary. Vitest's own duration line stays the per-shard detail.
- Shared OpenClaw test state: use `src/test-utils/openclaw-test-state.ts` from Vitest when a test needs an isolated `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, config fixture, workspace, agent dir, or auth-profile store.
- Process E2E helpers: use `test/helpers/openclaw-test-instance.ts` when a Vitest process-level E2E test needs a running Gateway, CLI env, log capture, and cleanup in one place.
- Docker/Bash E2E helpers: lanes that source `scripts/lib/docker-e2e-image.sh` can pass `docker_e2e_test_state_shell_b64 <label> <scenario>` into the container and decode it with `scripts/lib/openclaw-e2e-instance.sh`; multi-home scripts can pass `docker_e2e_test_state_function_b64` and call `openclaw_test_state_create <label> <scenario>` in each flow. Lower-level callers can use `scripts/lib/openclaw-test-state.mjs shell --label <name> --scenario <name>` for an in-container shell snippet, or `node scripts/lib/openclaw-test-state.mjs -- create --label <name> --scenario <name> --env-file <path> --json` for a sourceable host env file. The `--` before `create` keeps newer Node runtimes from treating `--env-file` as a Node flag. Docker/Bash lanes that launch a Gateway can source `scripts/lib/openclaw-e2e-instance.sh` inside the container for entrypoint resolution, mock OpenAI startup, Gateway foreground/background launch, readiness probes, state env export, log dumps, and process cleanup.
- Full, extension, and include-pattern shard runs update local timing data in `.artifacts/vitest-shard-timings.json`; later whole-config runs use those timings to balance slow and fast shards. Include-pattern CI shards append the shard name to the timing key, which keeps filtered shard timings visible without replacing whole-config timing data. Set `OPENCLAW_TEST_PROJECTS_TIMINGS=0` to ignore the local timing artifact.
- Selected `plugin-sdk` and `commands` test files now route through dedicated light lanes that keep only `test/setup.ts`, leaving runtime-heavy cases on their existing lanes.
- Source files with sibling tests map to that sibling before falling back to wider directory globs. Helper edits under `src/channels/plugins/contracts/test-helpers`, `src/plugin-sdk/test-helpers`, and `src/plugins/contracts` use a local import graph to run importing tests instead of broad-running every shard when the dependency path is precise.
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
- `pnpm test:docker:all`: Builds the shared live-test image, packs OpenClaw once as an npm tarball, builds/reuses a bare Node/Git runner image plus a functional image that installs that tarball into `/app`, then runs Docker smoke lanes with `OPENCLAW_SKIP_DOCKER_BUILD=1` through a weighted scheduler. The bare image (`OPENCLAW_DOCKER_E2E_BARE_IMAGE`) is used for installer/update/plugin-dependency lanes; those lanes mount the prebuilt tarball instead of using copied repo sources. The functional image (`OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`) is used for normal built-app functionality lanes. `scripts/package-openclaw-for-docker.mjs` is the single local/CI package packer and validates the tarball plus `dist/postinstall-inventory.json` before Docker consumes it. Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mjs`; planner logic lives in `scripts/lib/docker-e2e-plan.mjs`; `scripts/test-docker-all.mjs` executes the selected plan. `node scripts/test-docker-all.mjs --plan-json` emits the scheduler-owned CI plan for selected lanes, image kinds, package/live-image needs, state scenarios, and credential checks without building or running Docker. `OPENCLAW_DOCKER_ALL_PARALLELISM=<n>` controls process slots and defaults to 10; `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM=<n>` controls the provider-sensitive tail pool and defaults to 10. Heavy lane caps default to `OPENCLAW_DOCKER_ALL_LIVE_LIMIT=9`, `OPENCLAW_DOCKER_ALL_NPM_LIMIT=10`, and `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT=7`; provider caps default to one heavy lane per provider via `OPENCLAW_DOCKER_ALL_LIVE_CLAUDE_LIMIT=4`, `OPENCLAW_DOCKER_ALL_LIVE_CODEX_LIMIT=4`, and `OPENCLAW_DOCKER_ALL_LIVE_GEMINI_LIMIT=4`. Use `OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT` or `OPENCLAW_DOCKER_ALL_DOCKER_LIMIT` for larger hosts. If one lane exceeds the effective weight or resource cap on a low-parallelism host, it can still start from an empty pool and will run alone until it releases capacity. Lane starts are staggered by 2 seconds by default to avoid local Docker daemon create storms; override with `OPENCLAW_DOCKER_ALL_START_STAGGER_MS=<ms>`. The runner preflights Docker by default, cleans stale OpenClaw E2E containers, emits active-lane status every 30 seconds, shares provider CLI tool caches between compatible lanes, retries transient live-provider failures once by default (`OPENCLAW_DOCKER_ALL_LIVE_RETRIES=<n>`), and stores lane timings in `.artifacts/docker-tests/lane-timings.json` for longest-first ordering on later runs. Use `OPENCLAW_DOCKER_ALL_DRY_RUN=1` to print the lane manifest without running Docker, `OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS=<ms>` to tune status output, or `OPENCLAW_DOCKER_ALL_TIMINGS=0` to disable timing reuse. Use `OPENCLAW_DOCKER_ALL_LIVE_MODE=skip` for deterministic/local lanes only or `OPENCLAW_DOCKER_ALL_LIVE_MODE=only` for live-provider lanes only; package aliases are `pnpm test:docker:local:all` and `pnpm test:docker:live:all`. Live-only mode merges main and tail live lanes into one longest-first pool so provider buckets can pack Claude, Codex, and Gemini work together. The runner stops scheduling new pooled lanes after the first failure unless `OPENCLAW_DOCKER_ALL_FAIL_FAST=0` is set, and each lane has a 120-minute fallback timeout overrideable with `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`; selected live/tail lanes use tighter per-lane caps. CLI backend Docker setup commands have their own timeout via `OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS` (default 180). Per-lane logs, `summary.json`, `failures.json`, and phase timings are written under `.artifacts/docker-tests/<run-id>/`; use `pnpm test:docker:timings <summary.json>` to inspect slow lanes and `pnpm test:docker:rerun <run-id|summary.json|failures.json>` to print cheap targeted rerun commands.
- `pnpm test:docker:browser-cdp-snapshot`: Builds a Chromium-backed source E2E container, starts raw CDP plus an isolated Gateway, runs `browser doctor --deep`, and verifies CDP role snapshots include link URLs, cursor-promoted clickables, iframe refs, and frame metadata.
- CLI backend live Docker probes can be run as focused lanes, for example `pnpm test:docker:live-cli-backend:codex`, `pnpm test:docker:live-cli-backend:codex:resume`, or `pnpm test:docker:live-cli-backend:codex:mcp`. Claude and Gemini have matching `:resume` and `:mcp` aliases.
- `pnpm test:docker:openwebui`: Starts Dockerized OpenClaw + Open WebUI, signs in through Open WebUI, checks `/api/models`, then runs a real proxied chat through `/api/chat/completions`. Requires a usable live model key (for example OpenAI in `~/.profile`), pulls an external Open WebUI image, and is not expected to be CI-stable like the normal unit/e2e suites.
- `pnpm test:docker:mcp-channels`: Starts a seeded Gateway container and a second client container that spawns `openclaw mcp serve`, then verifies routed conversation discovery, transcript reads, attachment metadata, live event queue behavior, outbound send routing, and Claude-style channel + permission notifications over the real stdio bridge. The Claude notification assertion reads the raw stdio MCP frames directly so the smoke reflects what the bridge actually emits.
- `pnpm test:docker:upgrade-survivor`: Installs the packed OpenClaw tarball over a dirty old-user fixture, runs package update plus non-interactive doctor without live provider or channel keys, then starts a loopback Gateway and checks that agents, channel config, plugin allowlists, workspace/session files, stale legacy plugin dependency state, startup, and RPC status survive.
- `pnpm test:docker:published-upgrade-survivor`: Installs `openclaw@latest` by default, seeds realistic existing-user files without live provider or channel keys, configures that baseline with a baked `openclaw config set` command recipe, updates that published install to the packed OpenClaw tarball, runs non-interactive doctor, writes `.artifacts/upgrade-survivor/summary.json`, then starts a loopback Gateway and checks that configured intents, workspace/session files, stale plugin config and legacy dependency state, startup, `/healthz`, `/readyz`, and RPC status survive or repair cleanly. Override one baseline with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC`, expand an exact local matrix with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS` such as `openclaw@2026.5.2 openclaw@2026.4.23 openclaw@2026.4.15`, or add scenario fixtures with `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS=reported-issues`; the reported-issues set includes `configured-plugin-installs` to verify configured external OpenClaw plugins install automatically during upgrade and `stale-source-plugin-shadow` to keep source-only plugin shadows from breaking startup. Package Acceptance exposes those as `published_upgrade_survivor_baseline`, `published_upgrade_survivor_baselines`, and `published_upgrade_survivor_scenarios`, and resolves meta baseline tokens such as `last-stable-4` or `all-since-2026.4.23` before handing exact package specs to Docker lanes.
- `pnpm test:docker:update-migration`: Runs the published-upgrade survivor harness in the cleanup-heavy `plugin-deps-cleanup` scenario, starting at `openclaw@2026.4.23` by default. The separate `Update Migration` workflow expands this lane with `baselines=all-since-2026.4.23` so every stable published package from `.23` onward updates to the candidate and proves configured-plugin dependency cleanup outside Full Release CI.
- `pnpm test:docker:plugins`: Runs install/update smoke for local path, `file:`, npm registry packages with hoisted dependencies, git moving refs, ClawHub fixtures, marketplace updates, and Claude-bundle enable/inspect.

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
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case tasksJson --case tasksListJson --case tasksAuditJson --runs 3`
- `pnpm tsx scripts/bench-cli-startup.ts --entry openclaw.mjs --entry-secondary dist/entry.js --preset all`
- `pnpm tsx scripts/bench-cli-startup.ts --preset all --output .artifacts/cli-startup-bench-all.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case gatewayStatusJson --output .artifacts/cli-startup-bench-smoke.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --cpu-prof-dir .artifacts/cli-cpu`
- `pnpm tsx scripts/bench-cli-startup.ts --json`

Presets:

- `startup`: `--version`, `--help`, `health`, `health --json`, `status --json`, `status`
- `real`: `health`, `status`, `status --json`, `sessions`, `sessions --json`, `tasks --json`, `tasks list --json`, `tasks audit --json`, `agents list --json`, `gateway status`, `gateway status --json`, `gateway health --json`, `config get gateway.port`
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
- [Testing updates and plugins](/help/testing-updates-plugins)
