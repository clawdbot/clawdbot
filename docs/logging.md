---
summary: "Logging surfaces, file logs, WS log styles, and console formatting"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
---

# Logging

Clawdbot has two log “surfaces”:

- **Console output** (what you see in the terminal / Debug UI).
- **File logs** (JSON lines) written by the internal logger.

## File-based logger

Clawdbot uses a file logger backed by `tslog` (`src/logging.ts`).

- Default rolling log file is under `/tmp/clawdbot/` (one file per day): `clawdbot-YYYY-MM-DD.log`
- The log file path and level can be configured via `~/.clawdbot/clawdbot.json`:
  - `logging.file`
  - `logging.level`

The file format is one JSON object per line.

**Verbose vs. log levels**

- **File logs** are controlled exclusively by `logging.level`.
- `--verbose` only affects **console verbosity** (and WS log style); it does **not**
  raise the file log level.
- To capture verbose-only details in file logs, set `logging.level` to `debug` or
  `trace`.

## Console capture

The CLI entrypoint enables console capture (`src/index.ts` calls `enableConsoleCapture()`).
That means every `console.log/info/warn/error/debug/trace` is also written into the file logs,
while still behaving normally on stdout/stderr.

You can tune console verbosity independently via:

- `logging.consoleLevel` (default `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Tool summary redaction

Verbose tool summaries (e.g. `🛠️ bash: ...`) can mask sensitive tokens before they hit the
console stream. This is **tools-only** and does not alter file logs.

- `logging.redactSensitive`: `off` | `tools` (default: `tools`)
- `logging.redactPatterns`: array of regex strings (overrides defaults)
  - Use raw regex strings (auto `gi`), or `/pattern/flags` if you need custom flags.
  - Matches are masked by keeping the first 6 + last 4 chars (length >= 18), otherwise `***`.
  - Defaults cover common key assignments, CLI flags, JSON fields, bearer headers, PEM blocks, and popular token prefixes.

## Gateway WebSocket logs

The gateway prints WebSocket protocol logs in two modes:

- **Normal mode (no `--verbose`)**: only “interesting” RPC results are printed:
  - errors (`ok=false`)
  - slow calls (default threshold: `>= 50ms`)
  - parse errors
- **Verbose mode (`--verbose`)**: prints all WS request/response traffic.

### WS log style

`clawdbot gateway` supports a per-gateway style switch:

- `--ws-log auto` (default): normal mode is optimized; verbose mode uses compact output
- `--ws-log compact`: compact output (paired request/response) when verbose
- `--ws-log full`: full per-frame output when verbose
- `--compact`: alias for `--ws-log compact`

Examples:

```bash
# optimized (only errors/slow)
clawdbot gateway

# show all WS traffic (paired)
clawdbot gateway --verbose --ws-log compact

# show all WS traffic (full meta)
clawdbot gateway --verbose --ws-log full
```

## Console formatting (subsystem logging)

Clawdbot formats console logs via a small wrapper on top of the existing stack:

- **tslog** for structured file logs (`src/logging.ts`)
- **chalk** for colors (`src/globals.ts`)

The console formatter is **TTY-aware** and prints consistent, prefixed lines.
Subsystem loggers are created via `createSubsystemLogger("gateway")`.

Behavior:

- **Subsystem prefixes** on every line (e.g. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Subsystem colors** (stable per subsystem) plus level coloring
- **Color when output is a TTY or the environment looks like a rich terminal** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respects `NO_COLOR`
- **Shortened subsystem prefixes**: drops leading `gateway/` + `providers/`, keeps last 2 segments (e.g. `whatsapp/outbound`)
- **Sub-loggers by subsystem** (auto prefix + structured field `{ subsystem }`)
- **`logRaw()`** for QR/UX output (no prefix, no formatting)
- **Console styles** (e.g. `pretty | compact | json`)
- **Console log level** separate from file log level (file keeps full detail when `logging.level` is set to `debug`/`trace`)
- **WhatsApp message bodies** are logged at `debug` (use `--verbose` to see them)

This keeps existing file logs stable while making interactive output scannable.
