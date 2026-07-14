---
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
title: "Debugging"
---

Debugging helpers for streaming output, gateway iteration, and startup profiling.

## Runtime debug overrides

`/debug` sets **runtime-only** config overrides (memory, not disk). Disabled by default; enable with `commands.debug: true`.

```text
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` clears all overrides and returns to the on-disk config.

## Session trace output

`/trace` shows plugin-owned trace/debug lines for one session without enabling full verbose mode. Use it for plugin diagnostics such as Active Memory debug summaries; use `/verbose` for normal status/tool output.

```text
/trace
/trace on
/trace off
```

## Plugin lifecycle trace

Set `OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1` for a phase-by-phase breakdown of plugin metadata, discovery, registry, runtime mirror, config mutation, and refresh work. Writes to stderr, so JSON command output stays parseable.

```bash
OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1 openclaw plugins install tokenjuice --force
```

```text
[plugins:lifecycle] phase="config read" ms=6.83 status=ok command="install"
[plugins:lifecycle] phase="slot selection" ms=94.31 status=ok command="install" pluginId="tokenjuice"
[plugins:lifecycle] phase="registry refresh" ms=51.56 status=ok command="install" reason="source-changed"
```

Use this before reaching for a CPU profiler. From a source checkout, measure the built runtime with `node dist/entry.js ...` after `pnpm build`; `pnpm openclaw ...` also measures source-runner overhead.

## CLI startup and command profiling

Checked-in startup benchmarks:

```bash
pnpm test:startup:bench:smoke
pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --runs 3
pnpm tsx scripts/bench-cli-startup.ts --preset real --cpu-prof-dir .artifacts/cli-cpu
```

For one-off profiling through the normal source runner, set `OPENCLAW_RUN_NODE_CPU_PROF_DIR`:

```bash
OPENCLAW_RUN_NODE_CPU_PROF_DIR=.artifacts/cli-cpu pnpm openclaw status
```

The source runner adds Node CPU profile flags and writes a `.cpuprofile` for the command. Use this before adding temporary instrumentation to command code.

For startup stalls that look like synchronous filesystem or module-loader work, add Node's sync I/O trace flag through the source runner:

```bash
OPENCLAW_TRACE_SYNC_IO=1 pnpm openclaw gateway --force
```

`pnpm gateway:watch` leaves this flag disabled by default for the watched Gateway child; set `OPENCLAW_TRACE_SYNC_IO=1` when you want sync I/O trace output in watch mode too.

## Gateway watch mode

```bash
pnpm gateway:watch
```

By default this starts or restarts a tmux session named `openclaw-gateway-watch-<profile>` (for example `openclaw-gateway-watch-main`), with a port suffix such as `openclaw-gateway-watch-dev-19001` added only when `OPENCLAW_GATEWAY_PORT` differs from the default port `18789`. It auto-attaches from interactive terminals; non-interactive shells, CI, and agent exec calls stay detached and print attach instructions instead:

```bash
tmux attach -t openclaw-gateway-watch-main
# Read recent output without attaching
tmux capture-pane -ep -t openclaw-gateway-watch-main -S -200
```

The pane uses tmux `remain-on-exit`, so startup failures stay available for attach or capture instead of deleting the session. Re-running `pnpm gateway:watch` respawns that pane.

The tmux pane runs the raw watcher:

```bash
node scripts/watch-node.mjs gateway --force
```

Before watching the configured/default port, the tmux wrapper stops the active profile's installed Gateway service. This hands the port to the source watcher without launchd, systemd, or Scheduled Task respawning and replacing it. The service stays installed; restore it after the watch session with:

```bash
pnpm openclaw gateway start
```

When an explicit `--port` or `OPENCLAW_GATEWAY_PORT` differs from the installed service's effective port, the wrapper leaves the service running so both Gateways can run side by side.

Foreground mode without tmux:

```bash
pnpm gateway:watch:raw
# or
OPENCLAW_GATEWAY_WATCH_TMUX=0 pnpm gateway:watch
```

Raw mode does not manage the installed service. Run `pnpm openclaw gateway stop` first when it uses the same port.

Keep tmux management but disable auto-attach:

```bash
OPENCLAW_GATEWAY_WATCH_ATTACH=0 pnpm gateway:watch
```

Profile watched Gateway CPU time when debugging startup/runtime hotspots:

```bash
pnpm gateway:watch --benchmark
```

The watch wrapper consumes `--benchmark` before invoking the Gateway and writes one V8 `.cpuprofile` per Gateway child exit under `.artifacts/gateway-watch-profiles/`. Stop or restart the watched gateway to flush the current profile, then open it with Chrome DevTools or Speedscope:

```bash
npx speedscope .artifacts/gateway-watch-profiles/*.cpuprofile
```

- `--benchmark-dir <path>`: write profiles somewhere else.
- `--benchmark-no-force`: skip the default `--force` port cleanup and fail fast if the Gateway port is already in use.

Benchmark mode suppresses sync-I/O trace spam by default. Set `OPENCLAW_TRACE_SYNC_IO=1` with `--benchmark` to get both CPU profiles and sync-I/O stack traces; in benchmark mode those trace blocks go to `gateway-watch-output.log` under the benchmark directory (filtered from the terminal pane), while normal Gateway logs stay visible.

The tmux wrapper carries common non-secret runtime selectors into the pane, including `OPENCLAW_PROFILE`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, `OPENCLAW_GATEWAY_PORT`, and `OPENCLAW_SKIP_CHANNELS`. Put provider credentials in your normal profile/config, or use raw foreground mode for one-off ephemeral secrets.

If the watched Gateway exits during startup, the watcher runs `openclaw doctor --fix --non-interactive` once and restarts the Gateway child. Set `OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR=0` to see the original startup failure without the dev-only repair pass.

The managed tmux pane defaults to colored Gateway logs; set `FORCE_COLOR=0` when starting `pnpm gateway:watch` to disable ANSI output.

The watcher restarts on build-relevant files under `src/`, extension source files, extension `package.json` and `openclaw.plugin.json` metadata, `tsconfig.json`, `package.json`, and `tsdown.config.ts`. Extension metadata changes restart the gateway without forcing a rebuild; source and config changes still rebuild `dist` first.

Add gateway CLI flags after `gateway:watch` and they pass through on each restart. Re-running the same watch command respawns the named tmux pane; the raw watcher keeps a single-watcher lock so duplicate watcher parents are replaced instead of piling up.

## Dev profile + dev gateway (--dev)

Two **separate** `--dev` flags:

- **Global `--dev` (profile):** isolates state under `~/.openclaw-dev` and defaults the gateway port to `19001` (derived ports shift with it).
- **`gateway --dev`:** tells the Gateway to auto-create a default config + workspace when missing (and skip bootstrap).

Recommended flow (dev profile + dev bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Without a global install, run the CLI via `pnpm openclaw ...`.

What this does:

1. **Profile isolation** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas ports shift accordingly)

2. **Dev bootstrap** (`gateway --dev`)
   - Writes a minimal config if missing (`gateway.mode=local`, bind loopback).
   - Sets `agents.defaults.workspace` to the dev workspace and `agents.defaults.skipBootstrap=true`.
   - Seeds the workspace files if missing: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`.
   - Default identity: **C3-PO** (protocol droid).
   - `pnpm gateway:dev` also sets `OPENCLAW_SKIP_CHANNELS=1` to skip channel providers.

Reset flow (fresh start):

```bash
pnpm gateway:dev:reset
```

<Note>
`--dev` is a **global** profile flag and gets eaten by some runners. If you need to spell it out, use the env var form:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

</Note>

`--reset` wipes config, credentials, sessions, and the dev workspace (moved to trash, not deleted), then recreates the default dev setup.

<Tip>
If a non-dev gateway is already running (launchd or systemd), stop it first:

```bash
openclaw gateway stop
```

</Tip>

## Raw stream logging

OpenClaw can log the **raw assistant stream** before any filtering/formatting. This is the best way to see whether reasoning is arriving as plain text deltas (or as separate thinking blocks).

Enable it via CLI:

```bash
pnpm gateway:watch --raw-stream
```

Optional path override:

```bash
pnpm gateway:watch --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Equivalent env vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Default file: `~/.openclaw/logs/raw-stream.jsonl`

## Safety notes

- Raw stream logs can include full prompts, tool output, and user data.
- Keep logs local and delete them after debugging.
- If you share logs, scrub secrets and PII first.

## Debugging in VSCode

Source maps are required because the build hashes generated filenames. The included `launch.json` targets the Gateway service:

1. **Rebuild and Debug Gateway** - deletes `/dist` and rebuilds with debugging enabled before starting the Gateway.
2. **Debug Gateway** - debugs an existing build without touching `/dist`.

### Setup

1. Open **Run and Debug** (Activity Bar, or `Ctrl`+`Shift`+`D`).
2. Select **Rebuild and Debug Gateway** and press **Start Debugging**.

To manage the build/debug cycle manually instead:

1. Enable source maps in a terminal:
   - **Linux/macOS**: `export OUTPUT_SOURCE_MAPS=1`
   - **Windows (PowerShell)**: `$env:OUTPUT_SOURCE_MAPS="1"`
   - **Windows (CMD)**: `set OUTPUT_SOURCE_MAPS=1`
2. Rebuild: `pnpm clean:dist && pnpm build`
3. Select **Debug Gateway** and press **Start Debugging**.

Set breakpoints in `src/` TypeScript files; the debugger maps them to compiled JavaScript via source maps.

### Notes

- **Rebuild and Debug Gateway** deletes `/dist` and runs a full `pnpm build` with source maps on every launch.
- **Debug Gateway** can start/stop without affecting `/dist`, but you manage the build cycle in a separate terminal.
- Edit `launch.json` `args` to debug other CLI subcommands.
- To use the built CLI for other tasks (for example `dashboard --no-open` if your debug session spawns a new auth token), run it from another terminal: `node ./openclaw.mjs` or an alias like `alias openclaw-build="node $(pwd)/openclaw.mjs"`.

## Related

- [Troubleshooting](/help/troubleshooting)
- [FAQ](/help/faq)
