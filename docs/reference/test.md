---
summary: "How to run tests locally (vitest) and when to use force/coverage modes"
read_when:
  - Running or fixing tests
title: "Tests"
---

- Full testing kit (suites, live, Docker): [Testing](/help/testing)
- Update and plugin package validation: [Testing updates and plugins](/help/testing-updates-plugins)

## Agent default

Agent sessions run one/few focused tests and cheap static checks locally only
for trusted source and when the existing dependency install is ready. Never
execute untrusted repository tooling locally. Larger suites, changed gates with
typecheck/lint fan-out, builds, Docker, package lanes, E2E, live proof, and
cross-platform validation run remotely through Crabbox. Trusted maintainer
heavy proof defaults to Blacksmith Testbox. The configured Testbox workflow
hydrates credentials, so untrusted contributor or fork code must use
secretless fork CI or sanitized direct AWS Crabbox instead.

Do not pre-warm for anticipated work. Acquire the backend lazily when the
first heavy command is ready, reuse the returned `tbx_...` id for later heavy
commands, sync the current checkout on every run, and stop it before handoff.

After the first successful reuse, the wrapper records the lease's base,
dependency, and Testbox workflow fingerprint under `.crabbox/testbox-leases/`.
Source-only edits keep reusing the warmed box. A changed merge base, lockfile,
package-manager input, wrapper, or Testbox workflow fails closed and requires a
fresh lease. Every run still syncs the current checkout.
`OPENCLAW_TESTBOX_ALLOW_STALE=1` is only for intentional diagnostics, not
release proof.

Local test commands below are for human workflows and bounded agent proof.
Remote-provider unavailability must be reported; it is not permission to
silently run a broad local gate.

For untrusted heavy proof, lazily warm with `--provider aws`. Every run must set
`CRABBOX_ENV_ALLOW=CI`, pass `--provider aws --no-hydrate`, and use
a fresh temporary remote `HOME` before installing dependencies or running
tests. Use a newly warmed lease dedicated to that untrusted source; never reuse
a trusted or previously hydrated lease. Launch an installed trusted Crabbox
binary from a clean trusted `main` checkout and fetch only the remote PR with
`--fresh-pr`; never execute the untrusted checkout's wrapper or config locally.
Unset `CRABBOX_AWS_INSTANCE_PROFILE` and fail closed unless resolved
`aws.instanceProfile` is empty. Before any install/test, use trusted
absolute-path tools to require an IMDSv2 token, prove the IAM credentials
endpoint returns 404, and verify remote `git rev-parse HEAD` equals the full
reviewed PR head SHA. Bind the lease to that SHA and stop/rewarm when the head
changes. Upload trusted `scripts/crabbox-untrusted-bootstrap.sh` from clean
`main` alongside `--fresh-pr`; it installs pinned Node/pnpm, verifies the SHA
and package-manager pin, isolates `HOME`, installs dependencies, then executes
the requested test. If the broker cannot prove no role or no remote PR exists,
use secretless fork CI. Do not use `hydrate-github`, `--no-sync`, or a
credential-hydrated Testbox workflow.
Unset all `CRABBOX_TAILSCALE*` overrides, force `--network public
--tailscale=false`, clear exit-node/LAN flags, and require `crabbox inspect` to
report public networking with no Tailscale state before uploading any script.

## Routine local order

1. `pnpm test:changed` for changed-scope Vitest proof.
2. `pnpm test <path-or-filter>` for one file, directory, or explicit target.
3. `pnpm test` only when you intentionally need the full local Vitest suite.

In a Codex worktree or linked/sparse checkout, agents avoid direct local
`pnpm test*` / `pnpm check*` / `pnpm crabbox:run`:

- Bounded focused proof with ready dependencies:
  `node scripts/run-vitest.mjs <path-or-filter>`.
- Classify-first changed check: `node scripts/check-changed.mjs`; docs-only,
  no-change, and small metadata plans stay local when dependencies are ready,
  while heavy or dependency-missing plans delegate to Testbox.
- Explicit kept-lease broad proof: `node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox ... -- env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 corepack pnpm check:changed` so pnpm runs inside Testbox.
- The wrapper's final `exitCode` and timing JSON are the command result. A delegated Blacksmith GitHub Actions run may show `cancelled` after a successful SSH command because the Testbox is stopped from outside the keepalive action; check the wrapper summary and command output before treating that as a failure.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree <local-heavy-check command>`: keeps heavy-check serialization inside the current worktree instead of the Git common dir for commands such as `pnpm check:changed` and targeted `pnpm test ...`. Use it only on high-capacity local hosts when you intentionally run independent checks across linked worktrees.

## Core commands

Test wrapper runs end with a short `[test] passed|failed|skipped ... in ...` summary; Vitest's own duration line stays the per-shard detail.

| Command                                           | What it does                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                       | Explicit file/directory targets route through scoped Vitest lanes. Untargeted runs are full-suite proof: fixed shard groups expand to leaf configs for local parallel execution, with the expected shard fanout printed before starting. The extension group always expands to per-extension shard configs instead of one giant root-project process.           |
| `pnpm test:changed`                               | Cheap smart changed-test run: precise targets from direct test edits, sibling `*.test.ts` files, explicit source mappings, and the local import graph. Broad/config/package changes are skipped unless they map to precise tests.                                                                                                                               |
| `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` | Explicit broad changed-test run; use when a test harness/config/package edit should fall back to Vitest's broader changed-test behavior.                                                                                                                                                                                                                        |
| `pnpm test:force`                                 | Frees the configured OpenClaw gateway port (default `18789`), then runs the full suite with an isolated gateway port so server tests do not collide with a running instance.                                                                                                                                                                                    |
| `pnpm test:coverage`                              | Emits an informational V8 coverage report for the default unit lane (`vitest.unit.config.ts`); no coverage thresholds are enforced.                                                                                                                                                                                                                             |
| `pnpm test:coverage:changed`                      | Unit coverage only for files changed since `origin/main`.                                                                                                                                                                                                                                                                                                       |
| `pnpm changed:lanes`                              | Shows the architectural lanes triggered by the diff against `origin/main`.                                                                                                                                                                                                                                                                                      |
| `pnpm check:changed`                              | Classifies the changed lanes before choosing execution. Docs-only, no-change, and small metadata plans stay local when dependencies are ready; plans with typecheck/lint fan-out, other heavy lanes, or missing local dependencies delegate to Crabbox/Testbox outside CI. Does not run Vitest; use `pnpm test:changed` or `pnpm test <target>` for test proof. |

## Shared test state and process helpers

- `src/test-utils/openclaw-test-state.ts`: use from Vitest when a test needs an isolated `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, config fixture, workspace, agent dir, or auth-profile store.
- `pnpm test:env-mutations:report`: non-blocking report of tests/harnesses that mutate `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_WORKSPACE_DIR`, or related env keys directly. Use it to find migration candidates for the shared test-state helper.
- `test/helpers/openclaw-test-instance.ts`: process-level E2E tests needing a running Gateway, CLI env, log capture, and cleanup in one place.
- Docker/Bash E2E lanes that source `scripts/lib/docker-e2e-image.sh` can pass `docker_e2e_test_state_shell_b64 <label> <scenario>` into the container and decode it with `scripts/lib/openclaw-e2e-instance.sh`; multi-home scripts can pass `docker_e2e_test_state_function_b64` and call `openclaw_test_state_create <label> <scenario>` in each flow. `node scripts/lib/openclaw-test-state.mjs -- create --label <name> --scenario <name> --env-file <path> --json` writes a sourceable host env file (the `--` before `create` keeps newer Node runtimes from treating `--env-file` as a Node flag). Lanes that launch a Gateway can source `scripts/lib/openclaw-e2e-instance.sh` for entrypoint resolution, mock OpenAI startup, foreground/background launch, readiness probes, state env export, log dumps, and process cleanup.

## Control UI, TUI, and extension lanes

- **Control UI mocked E2E:** `pnpm test:ui:e2e` runs the Vitest + Playwright lane that starts the Vite Control UI and drives a real Chromium page against a mocked Gateway WebSocket. Tests live in `ui/src/**/*.e2e.test.ts`; shared mocks/controls live in `ui/src/test-helpers/control-ui-e2e.ts`. `pnpm test:e2e` includes this lane. Agent runs default to Testbox/Crabbox, including targeted proof; use `node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/ui/e2e/chat-flow.e2e.test.ts` only for an explicit local fallback.
- **TUI PTY tests:** `node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts` runs the fast fake-backend PTY lane. `OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1` or `pnpm tui:pty:test:watch --mode local` runs the slower `tui --local` smoke, which mocks only the external model endpoint. Assert stable visible text or fixture calls, not raw ANSI snapshots.
- `pnpm test:extensions` and `pnpm test extensions` run all extension/plugin shards. Heavy channel plugins, the browser plugin, and OpenAI run as dedicated shards; other plugin groups stay batched. `pnpm test extensions/<id>` runs one bundled plugin lane.
- Source files with sibling tests map to that sibling before falling back to wider directory globs. Helper edits under `src/channels/plugins/contracts/test-helpers`, `src/plugin-sdk/test-helpers`, and `src/plugins/contracts` use a local import graph to run importing tests instead of broad-running every shard when the dependency path is precise.
- Contract directory targets fan out to their contract lanes: `pnpm test src/channels/plugins/contracts` runs the four channel contract configs and `pnpm test src/plugins/contracts` runs the plugin contracts config, since the generic `channels`/`plugins` projects exclude `contracts/**`.
- `auto-reply` splits into three dedicated configs (`core`, `top-level`, `reply`) so the reply harness does not dominate the lighter top-level status/token/helper tests.
- Selected `plugin-sdk` and `commands` test files route through dedicated light lanes that keep only `test/setup.ts`, leaving runtime-heavy cases on their existing lanes.
- Base Vitest config defaults to `pool: "threads"` and `isolate: false`, with the shared non-isolated runner enabled across repo configs.
- `pnpm test:channels` runs `vitest.channels.config.ts`.

## Gateway and E2E

- Gateway integration is opt-in: `OPENCLAW_TEST_INCLUDE_GATEWAY=1 pnpm test` or `pnpm test:gateway`.
- `pnpm test:e2e`: repo E2E aggregate = `pnpm test:e2e:gateway && pnpm test:ui:e2e`.
- `pnpm test:e2e:gateway`: gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing). Defaults to `threads` + `isolate: false` with adaptive workers in `vitest.e2e.config.ts`; tune with `OPENCLAW_E2E_WORKERS=<n>`, verbose logs with `OPENCLAW_E2E_VERBOSE=1`.
- `pnpm test:live`: provider live tests (Claude/Minimax/DeepSeek/z.ai/etc, gated by `*.live.test.ts`). Requires API keys and `LIVE=1` (or `OPENCLAW_LIVE_TEST=1`) to unskip; verbose output with `OPENCLAW_LIVE_TEST_QUIET=0`.

## Full Docker suite (`pnpm test:docker:all`)

Builds the shared live-test image, packs OpenClaw once as an npm tarball, builds/reuses a bare Node/Git runner image plus a functional image that installs that tarball into `/app`, then runs Docker smoke lanes through a weighted scheduler. `scripts/package-openclaw-for-docker.mjs` is the single local/CI package packer and validates the tarball plus `dist/postinstall-inventory.json` before Docker consumes it.

- Bare image (`OPENCLAW_DOCKER_E2E_BARE_IMAGE`): installer/update/plugin-dependency lanes; mounts the prebuilt tarball instead of copied repo sources.
- Functional image (`OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`): normal built-app functionality lanes.
- Lane definitions: `scripts/lib/docker-e2e-scenarios.mjs`. Planner: `scripts/lib/docker-e2e-plan.mjs`. Executor: `scripts/test-docker-all.mjs`.
- `node scripts/test-docker-all.mjs --plan-json` emits the scheduler-owned CI plan (lanes, image kinds, package/live-image needs, state scenarios, credential checks) without building or running Docker.

Scheduling knobs (env vars, defaults in parentheses):

| Env var                                                                                                         | Default             | Purpose                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCLAW_DOCKER_ALL_PARALLELISM`                                                                               | 10                  | Process slots.                                                                                                                                                                                                                                                                             |
| `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM`                                                                          | 10                  | Provider-sensitive tail pool.                                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_LIVE_LIMIT`                                                                                | 9                   | Heavy live-provider lane cap.                                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_NPM_LIMIT`                                                                                 | 5                   | npm-resource lane cap.                                                                                                                                                                                                                                                                     |
| `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT`                                                                             | 7                   | Service-resource lane cap.                                                                                                                                                                                                                                                                 |
| `OPENCLAW_DOCKER_ALL_LIVE_CLAUDE_LIMIT` / `_CODEX_LIMIT` / `_GEMINI_LIMIT` / `_DROID_LIMIT` / `_OPENCODE_LIMIT` | 4                   | Per-provider heavy-lane caps.                                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_LIVE_OPENAI_LIMIT` / `_TELEGRAM_LIMIT`                                                     | 1                   | Narrower per-provider caps.                                                                                                                                                                                                                                                                |
| `OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT` / `OPENCLAW_DOCKER_ALL_DOCKER_LIMIT`                                         | -                   | Override for larger hosts.                                                                                                                                                                                                                                                                 |
| `OPENCLAW_DOCKER_ALL_START_STAGGER_MS`                                                                          | 2000                | Delay between lane starts, avoids local Docker daemon create storms.                                                                                                                                                                                                                       |
| `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`                                                                           | 7,200,000 (120 min) | Per-lane fallback timeout; selected live/tail lanes use tighter caps.                                                                                                                                                                                                                      |
| `OPENCLAW_DOCKER_ALL_LIVE_RETRIES`                                                                              | 1                   | Retries for transient live-provider failures.                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_DRY_RUN`                                                                                   | off                 | Print the lane manifest without running Docker.                                                                                                                                                                                                                                            |
| `OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS`                                                                        | 30000               | Active-lane status print interval.                                                                                                                                                                                                                                                         |
| `OPENCLAW_DOCKER_ALL_TIMINGS`                                                                                   | on                  | Reuse `.artifacts/docker-tests/lane-timings.json` for longest-first ordering; set to `0` to disable.                                                                                                                                                                                       |
| `OPENCLAW_DOCKER_ALL_LIVE_MODE`                                                                                 | -                   | `skip` for deterministic/local lanes only, `only` for live-provider lanes only. Aliases: `pnpm test:docker:local:all`, `pnpm test:docker:live:all`. Live-only mode merges main and tail live lanes into one longest-first pool so provider buckets pack Claude/Codex/Gemini work together. |
| `OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS`                                                               | 180                 | CLI backend Docker setup timeout.                                                                                                                                                                                                                                                          |

Env var pattern for resource caps is `OPENCLAW_DOCKER_ALL_<RESOURCE>_LIMIT` (resource name uppercased, non-alphanumerics collapsed to `_`).

Other behavior: the runner preflights Docker by default, cleans stale OpenClaw E2E containers, shares provider CLI tool caches between compatible lanes, and stops scheduling new pooled lanes after the first failure unless `OPENCLAW_DOCKER_ALL_FAIL_FAST=0` is set. If one lane exceeds the effective weight/resource cap on a low-parallelism host, it can still start from an empty pool and run alone until it releases capacity. Per-lane logs, `summary.json`, `failures.json`, and phase timings write under `.artifacts/docker-tests/<run-id>/`; use `pnpm test:docker:timings <summary.json>` to inspect slow lanes and `pnpm test:docker:rerun <run-id|summary.json|failures.json>` to print cheap targeted rerun commands.

### Notable Docker lanes

| Command                                                                     | Verifies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:docker:browser-cdp-snapshot`                                     | Chromium-backed source E2E container with raw CDP + isolated Gateway; `browser doctor --deep` CDP role snapshots include link URLs, cursor-promoted clickables, iframe refs, and frame metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test:docker:skill-install`                                            | Installs the packed tarball in a bare Docker runner with `skills.install.allowUploadedArchives: false`, resolves a current skill slug from live ClawHub search, installs via `openclaw skills install`, and verifies `SKILL.md`, `.clawhub/origin.json`, `.clawhub/lock.json`, and `skills info --json`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm test:docker:live-cli-backend:claude`, `:claude:resume`, `:claude:mcp` | Focused CLI backend live probes; Gemini has matching `:resume` and `:mcp` aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:docker:openwebui`                                                | Dockerized OpenClaw + Open WebUI: sign in, check `/api/models`, run a real proxied chat through `/api/chat/completions`. Requires a usable live model key and pulls an external image; not expected to be CI-stable like the unit/e2e suites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test:docker:mcp-channels`                                             | Seeded Gateway container plus a client container spawning `openclaw mcp serve`: routed conversation discovery, transcript reads, attachment metadata, live event queue behavior, outbound send routing, and Claude-style channel + permission notifications over the real stdio bridge (assertion reads raw stdio MCP frames directly).                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm test:docker:hosting-profiles`                                         | Blocking package-acceptance release proof for built-in hosting-profile selection and `/readyz` condition aggregation. The lane proves default `local`; ready and loopback-invalid `container` bindings; ready trusted-proxy and invalid token-auth `reverse-proxy` postures; `node-mode` transitioning from `503` to `200` after a real node host is paired, connected, and advertising an approved command; and workspace writability transitioning from ready to `WorkspaceStorageFull` and back without restarting. It also checks required versus advisory conditions and stable failure/advisory arrays.                                                                                                                                         |
| `pnpm test:docker:upgrade-survivor`                                         | Installs the packed tarball over a dirty old-user fixture, runs package update plus non-interactive doctor without live provider/channel keys, starts a loopback Gateway, checks agents/channel config/plugin allowlists/workspace/session files/stale legacy plugin dependency state/startup/RPC status survive.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test:docker:published-upgrade-survivor`                               | Installs `openclaw@latest` by default, seeds realistic existing-user files, configures via a baked `openclaw config set` recipe, updates to the packed tarball, runs non-interactive doctor, writes `.artifacts/upgrade-survivor/summary.json`, checks `/healthz`, `/readyz`, RPC status. Override with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC`, expand a matrix with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, or add scenario fixtures with `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS=reported-issues` (includes `configured-plugin-installs` and `stale-source-plugin-shadow`). Package Acceptance exposes these as `published_upgrade_survivor_baseline(s)` / `_scenarios` and resolves meta tokens like `last-stable-4` or `all-since-2026.4.23`. |
| `pnpm test:docker:update-migration`                                         | Published-upgrade survivor harness in the `plugin-deps-cleanup` scenario, starting at `openclaw@2026.4.23` by default. The `Update Migration` workflow expands this with `baselines=all-since-2026.4.23` to prove configured-plugin dependency cleanup outside Full Release CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test:docker:plugins`                                                  | Install/update smoke for local path, `file:`, npm registry packages with hoisted dependencies, git moving refs, ClawHub fixtures, marketplace updates, and Claude-bundle enable/inspect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Local PR gate

For local PR land/gate checks, run:

- `pnpm check:changed`
- `pnpm check`
- `pnpm check:test-types`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

If `pnpm test` flakes on a loaded host, rerun once before treating it as a regression, then isolate with `pnpm test <path/to/test>`. For memory-constrained hosts:

- `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`
- `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache pnpm test:changed`

## Test performance tooling

- `pnpm test:perf:imports`: enables Vitest import-duration + import-breakdown reporting, while still using scoped lane routing for explicit file/directory targets. `pnpm test:perf:imports:changed` scopes the same profiling to files changed since `origin/main`.
- `pnpm test:perf:changed:bench -- --ref <git-ref>` benchmarks the routed changed-mode path against the native root-project run for the same committed git diff; `pnpm test:perf:changed:bench -- --worktree` benchmarks the current worktree change set without committing first.
- `pnpm test:perf:profile:main` writes a CPU profile for the Vitest main thread (`.artifacts/vitest-main-profile`); `pnpm test:perf:profile:runner` writes CPU + heap profiles for the unit runner (`.artifacts/vitest-runner-profile`).
- `pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json`: runs every full-suite Vitest leaf config serially and writes grouped duration data plus per-config JSON/log artifacts. Full-suite reports isolate files by default so retained module graphs and GC pauses from earlier files are not charged to later assertions; pass `-- --no-isolate` only when intentionally profiling shared-worker accumulation. The Test Performance Agent uses this as its baseline before attempting slow-test fixes. `pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json` compares grouped reports after a performance-focused change.
- Full, extension, and include-pattern shard runs update local timing data in `.artifacts/vitest-shard-timings.json`; later whole-config runs use those timings to balance slow and fast shards. Include-pattern CI shards append the shard name to the timing key, which keeps filtered shard timings visible without replacing whole-config timing data. Set `OPENCLAW_TEST_PROJECTS_TIMINGS=0` to ignore the local timing artifact.

## Benchmarks

<Accordion title="Model latency (scripts/bench-model.ts)">

```bash
pnpm tsx scripts/bench-model.ts --runs 10
```

Optional env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`. Default prompt: "Reply with a single word: ok. No punctuation or extra text."

</Accordion>

<Accordion title="CLI startup (scripts/bench-cli-startup.ts)">

```bash
pnpm test:startup:bench
pnpm test:startup:bench:smoke
pnpm test:startup:bench:save
pnpm test:startup:bench:update
pnpm test:startup:bench:check
pnpm tsx scripts/bench-cli-startup.ts --runs 12
pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --case gatewayStatus --runs 3
pnpm tsx scripts/bench-cli-startup.ts --entry openclaw.mjs --entry-secondary dist/entry.js --preset all
```

Presets:

- `startup`: `--version`, `--help`, `health`, `health --json`, `status --json`, `status`
- `real`: `health`, `status`, `status --json`, `sessions`, `sessions --json`, `tasks --json`, `tasks list --json`, `tasks audit --json`, `agents list --json`, `gateway status`, `gateway status --json`, `gateway health --json`, `config get gateway.port`
- `all`: both presets combined

Output includes `sampleCount`, avg, p50, p95, min/max, exit-code/signal distribution, and max RSS per command. `--cpu-prof-dir` / `--heap-prof-dir` write V8 profiles per run.

Saved output: `pnpm test:startup:bench:smoke` writes `.artifacts/cli-startup-bench-smoke.json`; `pnpm test:startup:bench:save` writes `.artifacts/cli-startup-bench-all.json` (`runs=5 warmup=1`). Checked-in fixture: `test/fixtures/cli-startup-bench.json`, refreshed by `pnpm test:startup:bench:update`, compared by `pnpm test:startup:bench:check`.

</Accordion>

<Accordion title="Gateway startup (scripts/bench-gateway-startup.ts)">

Defaults to the built CLI entry at `dist/entry.js`; run `pnpm build` first. Pass `--entry scripts/run-node.mjs` to measure the source runner instead, and keep those results separate from built-entry baselines.

```bash
pnpm test:startup:gateway -- --runs 5 --warmup 1
pnpm test:startup:gateway -- --case skipChannels --case fiftyPlugins --runs 5
node --import tsx scripts/bench-gateway-startup.ts --case default --runs 5 --output .artifacts/gateway-startup.json
```

Case ids: `default`, `skipChannels` (channel startup skipped), `oneInternalHook`, `allInternalHooks`, `fiftyPlugins` (50 manifest plugins), `fiftyStartupLazyPlugins` (50 startup-lazy manifest plugins).

Output includes first process output, `/healthz`, `/readyz`, HTTP listen log time, Gateway ready log time, CPU time, CPU core ratio, max RSS, heap, startup trace metrics, event-loop delay, and plugin lookup-table detail metrics. The script sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` in the child Gateway environment.

`/healthz` is liveness (HTTP server can answer). `/readyz` is usable readiness (startup plugin sidecars, channels, and ready-critical post-attach work have settled). Startup hooks dispatch asynchronously and are not part of the readiness guarantee. Ready log time is the Gateway's internal timestamp, useful for process-side attribution but not a substitute for the external `/readyz` probe.

Use JSON output or `--output` when comparing changes. Use `--cpu-prof-dir` only after trace output points at import, compile, or CPU-bound work that phase timings alone cannot explain.

</Accordion>

<Accordion title="Gateway restart (scripts/bench-gateway-restart.ts)">

macOS and Linux only (uses SIGUSR1 for in-process restarts; fails immediately on Windows). Same built-entry default and `--entry scripts/run-node.mjs` override as gateway startup above.

```bash
pnpm test:restart:gateway -- --case skipChannels --runs 1 --restarts 5
pnpm test:restart:gateway -- --case default --runs 3 --restarts 3 --warmup 1
```

Case ids: `skipChannels`, `skipChannelsAcpxProbe` (ACPX startup probe on), `skipChannelsNoAcpxProbe` (probe off), `default`, `fiftyPlugins`.

Output includes next `/healthz`, next `/readyz`, downtime, restart ready timing, CPU, RSS, startup trace metrics for the replacement process, and restart trace metrics for signal handling, active-work drain, close phases, next start, ready timing, and memory snapshots. The script sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` and `OPENCLAW_GATEWAY_RESTART_TRACE=1`.

Use this benchmark when a change touches restart signaling, close handlers, startup-after-restart, sidecar shutdown, service handoff, or readiness after restart. Start with `skipChannels` to isolate Gateway mechanics from channel startup; use `default` or plugin-heavy cases only after the narrow case explains the restart path. Trace metrics are attribution hints, not verdicts — judge a restart change from multiple samples, the matching owner span, `/healthz`/`/readyz` behavior, and the user-visible restart contract.

</Accordion>

## Onboarding E2E (Docker)

Optional; only needed for containerized onboarding smoke tests. Full cold-start flow in a clean Linux container:

```bash
scripts/e2e/onboard-docker.sh
```

Drives the interactive wizard via a pseudo-tty, verifies config/workspace/session files, then starts the gateway and runs `openclaw health`.

## QR import smoke (Docker)

Ensures the maintained QR runtime helper loads under the supported Docker Node runtimes (Node 24 default, Node 22 compatible):

```bash
pnpm test:docker:qr
```

## Related

- [Testing](/help/testing)
- [Testing live](/help/testing-live)
- [Testing updates and plugins](/help/testing-updates-plugins)
