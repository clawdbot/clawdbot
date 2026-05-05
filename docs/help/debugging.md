---
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
title: "Debugging"
---

Debugging helpers for streaming output, especially when a provider mixes reasoning into normal text.

## Runtime debug overrides

Use `/debug` in chat to set **runtime-only** config overrides (memory, not disk).
`/debug` is disabled by default; enable with `commands.debug: true`.
This is handy when you need to toggle obscure settings without editing `openclaw.json`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` clears all overrides and returns to the on-disk config.

## Session trace output

Use `/trace` when you want to see plugin-owned trace/debug lines in one session
without turning on full verbose mode.

Examples:

```text
/trace
/trace on
/trace off
```

Use `/trace` for plugin diagnostics such as Active Memory debug summaries.
Keep using `/verbose` for normal verbose status/tool output, and keep using
`/debug` for runtime-only config overrides.

## Plugin lifecycle trace

Use `OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1` when plugin lifecycle commands feel slow
and you need a built-in phase breakdown for plugin metadata, discovery, registry,
runtime mirror, config mutation, and refresh work. The trace is opt-in and writes
to stderr, so JSON command output remains parseable.

Example:

```bash
OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1 openclaw plugins install tokenjuice --force
```

Example output:

```text
[plugins:lifecycle] phase="config read" ms=6.83 status=ok command="install"
[plugins:lifecycle] phase="slot selection" ms=94.31 status=ok command="install" pluginId="tokenjuice"
[plugins:lifecycle] phase="registry refresh" ms=51.56 status=ok command="install" reason="source-changed"
```

Use this for plugin lifecycle investigation before reaching for a CPU profiler.
If the command is running from a source checkout, prefer measuring the built
runtime with `node dist/entry.js ...` after `pnpm build`; `pnpm openclaw ...`
also measures source-runner overhead.

## CLI startup and command profiling

Use the checked-in startup benchmark when a command feels slow:

```bash
pnpm test:startup:bench:smoke
pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --runs 3
pnpm tsx scripts/bench-cli-startup.ts --preset real --cpu-prof-dir .artifacts/cli-cpu
```

For one-off profiling through the normal source runner, set
`OPENCLAW_RUN_NODE_CPU_PROF_DIR`:

```bash
OPENCLAW_RUN_NODE_CPU_PROF_DIR=.artifacts/cli-cpu pnpm openclaw status
```

The source runner adds Node CPU profile flags and writes a `.cpuprofile` for the
command. Use this before adding temporary instrumentation to command code.

For startup stalls that look like synchronous filesystem or module-loader work,
add Node's sync I/O trace flag through the source runner:

```bash
OPENCLAW_TRACE_SYNC_IO=1 pnpm openclaw gateway --force
```

`pnpm gateway:watch` enables this flag by default for the watched Gateway child.
Set `OPENCLAW_TRACE_SYNC_IO=0` to suppress Node sync I/O trace output in watch
mode.

## Gateway watch mode

For fast iteration, run the gateway under the file watcher:

```bash
pnpm gateway:watch
```

By default, this starts or restarts a tmux session named
`openclaw-gateway-watch-main` (or a profile/port-specific variant such as
`openclaw-gateway-watch-dev-19001`) and auto-attaches from interactive terminals.
Non-interactive shells, CI, and agent exec calls stay detached and print attach
instructions instead. Attach manually when needed:

```bash
tmux attach -t openclaw-gateway-watch-main
```

The tmux pane runs the raw watcher:

```bash
node scripts/watch-node.mjs gateway --force
```

Use foreground mode when tmux is not wanted:

```bash
pnpm gateway:watch:raw
# or
OPENCLAW_GATEWAY_WATCH_TMUX=0 pnpm gateway:watch
```

Disable auto-attach while keeping tmux management:

```bash
OPENCLAW_GATEWAY_WATCH_ATTACH=0 pnpm gateway:watch
```

Profile watched Gateway CPU time when debugging startup/runtime hotspots:

```bash
pnpm gateway:watch --benchmark
```

The watch wrapper consumes `--benchmark` before invoking the Gateway and writes
one V8 `.cpuprofile` per Gateway child exit under
`.artifacts/gateway-watch-profiles/`. Stop or restart the watched gateway to
flush the current profile, then open it with Chrome DevTools or Speedscope:

```bash
npx speedscope .artifacts/gateway-watch-profiles/*.cpuprofile
```

Use `--benchmark-dir <path>` when you want profiles somewhere else.
Use `--benchmark-no-force` when you want the benchmarked child to skip the
default `--force` port cleanup and fail fast if the Gateway port is already in
use.
Benchmark mode suppresses sync-I/O trace spam by default. Set
`OPENCLAW_TRACE_SYNC_IO=1` with `--benchmark` when you explicitly want both CPU
profiles and Node sync-I/O stack traces. In benchmark mode those trace blocks
are written to `gateway-watch-output.log` under the benchmark directory and
filtered from the terminal pane; normal Gateway logs remain visible.

The tmux wrapper carries common non-secret runtime selectors such as
`OPENCLAW_PROFILE`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`,
`OPENCLAW_GATEWAY_PORT`, and `OPENCLAW_SKIP_CHANNELS` into the pane. Put
provider credentials in your normal profile/config, or use raw foreground mode
for one-off ephemeral secrets.
If the watched Gateway exits during startup, the watcher runs
`openclaw doctor --fix --non-interactive` once and restarts the Gateway child.
Use `OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR=0` when you want the original startup
failure without the dev-only repair pass.
The managed tmux pane also defaults to colored Gateway logs for readability;
set `FORCE_COLOR=0` when starting `pnpm gateway:watch` to disable ANSI output.

The watcher restarts on build-relevant files under `src/`, extension source files,
extension `package.json` and `openclaw.plugin.json` metadata, `tsconfig.json`,
`package.json`, and `tsdown.config.ts`. Extension metadata changes restart the
gateway without forcing a `tsdown` rebuild; source and config changes still
rebuild `dist` first.

Add any gateway CLI flags after `gateway:watch` and they will be passed through on
each restart. Re-running the same watch command respawns the named tmux pane, and
the raw watcher still keeps its single-watcher lock so duplicate watcher parents
are replaced instead of piling up.

## Dev profile + dev gateway (--dev)

Use the dev profile to isolate state and spin up a safe, disposable setup for
debugging. There are **two** `--dev` flags:

- **Global `--dev` (profile):** isolates state under `~/.openclaw-dev` and
  defaults the gateway port to `19001` (derived ports shift with it).
- **`gateway --dev`: tells the Gateway to auto-create a default config +
  workspace** when missing (and skip BOOTSTRAP.md).

Recommended flow (dev profile + dev bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

If you don’t have a global install yet, run the CLI via `pnpm openclaw ...`.

What this does:

1. **Profile isolation** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas shift accordingly)

2. **Dev bootstrap** (`gateway --dev`)
   - Writes a minimal config if missing (`gateway.mode=local`, bind loopback).
   - Sets `agent.workspace` to the dev workspace.
   - Sets `agent.skipBootstrap=true` (no BOOTSTRAP.md).
   - Seeds the workspace files if missing:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Default identity: **C3‑PO** (protocol droid).
   - Skips channel providers in dev mode (`OPENCLAW_SKIP_CHANNELS=1`).

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

`--reset` wipes config, credentials, sessions, and the dev workspace (using
`trash`, not `rm`), then recreates the default dev setup.

<Tip>
If a non-dev gateway is already running (launchd or systemd), stop it first:

```bash
openclaw gateway stop
```

</Tip>

## Raw stream logging (OpenClaw)

OpenClaw can log the **raw assistant stream** before any filtering/formatting.
This is the best way to see whether reasoning is arriving as plain text deltas
(or as separate thinking blocks).

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

Default file:

`~/.openclaw/logs/raw-stream.jsonl`

## Raw chunk logging (pi-mono)

To capture **raw OpenAI-compat chunks** before they are parsed into blocks,
pi-mono exposes a separate logger:

```bash
PI_RAW_STREAM=1
```

Optional path:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Default file:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Note: this is only emitted by processes using pi-mono’s
> `openai-completions` provider.

## Safety notes

- Raw stream logs can include full prompts, tool output, and user data.
- Keep logs local and delete them after debugging.
- If you share logs, scrub secrets and PII first.

## Related

- [Troubleshooting](/help/troubleshooting)
- [FAQ](/help/faq)
