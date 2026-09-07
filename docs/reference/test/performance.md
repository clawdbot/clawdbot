---
summary: "Import profiling, CPU and heap profiles, shard timings, and benchmark scripts"
title: "Test performance and benchmarks"
read_when:
  - You are profiling a slow test run
  - You need a startup, gateway, or model latency benchmark
---

## Test performance tooling

- `pnpm test:perf:imports`: enables Vitest import-duration + import-breakdown reporting, while still using scoped lane routing for explicit file/directory targets. `pnpm test:perf:imports:changed` scopes the same profiling to files changed since `origin/main`.
- `pnpm test:perf:changed:bench -- --ref <git-ref>` benchmarks the routed changed-mode path against the native root-project run for the same committed git diff; `pnpm test:perf:changed:bench -- --worktree` benchmarks the current worktree change set without committing first.
- `pnpm test:perf:profile:main` writes a CPU profile for the Vitest main thread; `pnpm test:perf:profile:runner` writes CPU + heap profiles for each unit worker. Both print their output directory (a temporary directory by default). Use `-- --output-dir <dir>` or `OPENCLAW_VITEST_PROFILE_DIR` to retain profiles at a chosen location.
- `pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json`: runs every full-suite Vitest leaf config serially and writes grouped duration data plus per-config JSON/log artifacts. Full-suite reports isolate files by default so retained module graphs and GC pauses from earlier files are not charged to later assertions; pass `-- --no-isolate` only when intentionally profiling shared-worker accumulation. `pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json` compares grouped reports after a performance-focused change.
- Full, extension, and include-pattern shard runs update local timing data in `.artifacts/vitest-shard-timings.json`; later whole-config runs use those timings to balance slow and fast shards. Include-pattern CI shards append the shard name to the timing key, which keeps filtered shard timings visible without replacing whole-config timing data. Set `OPENCLAW_TEST_PROJECTS_TIMINGS=0` to ignore the local timing artifact.
- `pnpm ci:timings:refit`: regenerate committed `config/ci-test-timings.json` from the last five successful main CI runs; add `--dry-run` to preview the changed-entry table. This file owns per-file UI E2E and per-profile compact-group weights, unlike the gitignored `.artifacts/vitest-shard-timings.json` whole-config timing cache. Independent CI shards use only the committed weights, never that cache. See [CI timing refits](/ci/capacity#measured-shard-weights) for the daily refresh and sampling rules.

Runner profiling preserves the selected `forks` or `threads` pool, isolation, environment, and custom runners extending Vitest's `TestRunner`. Capture starts in a Node preload before Vitest worker imports, spans all files assigned to that worker, and finishes both profile files in awaited worker cleanup before teardown is acknowledged. It does not depend on exit-time profile flushing. Root global setup configures every selected project without replacing its reporters or setup. Main capture spans Vitest/Vite startup through run completion and close. Process termination before cleanup, bootstrap failures before runner construction, and teardown timeouts can still prevent output. Browser/VM pools, custom runners without `onCleanupWorkerContext`, and additional native `--cpu-prof`/`--heap-prof` flags are rejected for runner profiling.

Forward Vitest options after the profiler separator. Forwarded options use Vitest's native CLI validation before loading config. Config-only settings, such as `runner` and `globalSetup`, belong in the Vitest config file, not CLI flags. For example:

```bash
pnpm test:perf:profile:runner -- --output-dir .artifacts/profiles -- --config test/vitest/vitest.unit.config.ts --pool threads
```

`pnpm test:extensions:memory` profiles built plugin index entries from `dist/extensions` (including nested `dist` output) and package-local `extensions/<id>/dist` output; TypeScript source entries are excluded. Root artifacts take precedence when both builds exist. Selecting an already-built plugin with `--extension <id>` reuses its output without requiring unrelated plugin builds; build the plugin package first if its output is not supplied by `pnpm build`.

Native imports also need the plugin's declared dependencies and a resolvable `openclaw` host package. The profiler does not install or link dependencies: missing dependencies remain import failures in the JSON report and cause a nonzero exit.

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

Gateway startup, restart, and agent concurrency benchmark fixtures use temporary home and state directories, loopback binding, and `discovery.mdns.mode: "off"` so synthetic Gateways do not advertise on the LAN, including on macOS.

Defaults to the built CLI entry at `dist/entry.js`; run `pnpm build` first. Pass `--entry scripts/run-node.mjs` to measure the source runner instead, and keep those results separate from built-entry baselines.

```bash
pnpm test:startup:gateway -- --runs 5 --warmup 1
pnpm test:startup:gateway -- --case skipChannels --case fiftyPlugins --runs 5
node --import tsx scripts/bench-gateway-startup.ts --case default --runs 5 --output .artifacts/gateway-startup.json
node --import tsx scripts/bench-gateway-startup.ts --case incidentCombined --runs 5 --warmup 1 --timeout-ms 60000 --output .artifacts/gateway-startup-incident.json
```

Case ids: `default`, `skipChannels` (channel startup skipped), `oneInternalHook`, `allInternalHooks`, `fiftyPlugins` (50 manifest plugins), `fiftyStartupLazyPlugins` (50 startup-lazy manifest plugins), `incidentDatabase`, `incidentNullMetadata`, `incidentWorkspace`, `incidentPackagedPlugins`, and `incidentCombined`.

The incident cases are opt-in because each sample builds an isolated, non-sensitive load fixture: current global and agent databases, 100,000 retained audit rows with freelist fragmentation, eight agent workspaces containing 80,000 files (about 800 MB), and the packaged plugin inventory. Run the combined case only on a clean machine with enough free disk space; the fixture directory is removed after each sample. `incidentCombined` fails when `/healthz` p95 reaches 30 seconds or `/readyz` p95 reaches 60 seconds.

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
