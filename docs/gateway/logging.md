---
summary: "Logging surfaces, file logs, WS log styles, and console formatting"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
title: "Gateway logging"
---

# Logging

For a user-facing overview (CLI + Control UI + config), see [/logging](/logging).

OpenClaw has two log surfaces:

- **Console output** - what you see in the terminal / Debug UI.
- **File logs** - JSON lines written by the gateway logger.

At startup, the Gateway logs the resolved default agent model plus the mode defaults that affect new sessions:

```text
agent model: openai/gpt-5.6-sol (thinking=medium, fast=on)
```

`thinking` comes from the default agent, model params, or the global agent default; when unset it shows `medium`. `fast` comes from the default agent or the model's `fastMode` params.

## File-based logger

- Default rolling log file is under `/tmp/openclaw/` (one file per day): `openclaw-YYYY-MM-DD.log`, dated by the gateway host's local timezone. If that directory is unsafe or unwritable (wrong owner, world-writable, a symlink), OpenClaw falls back to a user-scoped `os.tmpdir()/openclaw-<uid>` path instead; on Windows it always uses that OS-tmpdir fallback.
- Active log files rotate at `logging.maxFileBytes` (default: 100 MB), keeping up to five numbered archives (`.1` through `.5`) and continuing to write a fresh active file.
- Configure the log file path and level via `~/.openclaw/openclaw.json`: `logging.file`, `logging.level`.
- The file format is one JSON object per line.

Talk, realtime voice, and managed-room code paths use the shared file logger for bounded lifecycle records intended for operational debugging and OTLP log export. Transcript text, audio payloads, turn ids, call ids, and provider item ids are never copied into the log record.

The Control UI Logs tab tails this file via the gateway (`logs.tail`). The CLI does the same:

```bash
openclaw logs --follow
```

### Verbose vs. log levels

- **File logs** are controlled exclusively by `logging.level`.
- `--verbose` only affects **console verbosity** (and WS log style) - it does **not** raise the file log level.
- To capture verbose-only details in file logs, set `logging.level` to `debug` or `trace`.
- Trace logging also includes diagnostic timing summaries for selected hot paths, such as plugin tool factory preparation. See [/tools/plugin#slow-plugin-tool-setup](/tools/plugin#slow-plugin-tool-setup).

## Console capture

The CLI captures `console.log/info/warn/error/debug/trace`, writes them to file logs, and still prints to stdout/stderr.

Tune console verbosity independently:

- `logging.consoleLevel` (default `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`; defaults to `pretty` on a TTY, `compact` otherwise)

## Redaction

OpenClaw masks sensitive tokens before log or transcript output leaves the process. This redaction policy applies at console, file-log, OTLP log-record, and session transcript text sinks, so matching secret values are masked before JSONL lines or messages are written to disk.

- Sensitive-value redaction is always enabled.
- `logging.redactPatterns`: array of regex strings (overrides defaults)
  - Use raw regex strings (auto `gi`), or `/pattern/flags` for custom flags.
  - Matches are masked keeping the first 6 + last 4 chars (values >= 18 chars); shorter values become `***`.
  - Defaults cover common key assignments, CLI flags, JSON fields, bearer headers, PEM blocks, popular vendor token prefixes, and payment credential field names (card number, CVC/CVV, shared payment token, payment credential).

Safety boundaries such as Control UI tool-call events, `sessions_history` output, diagnostics exports, provider errors, exec approval display, and Gateway WebSocket logs always redact. `logging.redactPatterns` adds deployment-specific patterns.

## Gateway WebSocket logs

The gateway prints WebSocket protocol logs in two modes:

- **Normal mode (no `--verbose`)**: only "interesting" RPC results print - errors (`ok=false`), slow calls (default threshold: `>= 50ms`), and parse errors.
- **Verbose mode (`--verbose`)**: prints all WS request/response traffic.

### WS log style

`openclaw gateway` supports a per-gateway style switch:

- `--ws-log auto` (default): normal mode is optimized; verbose mode uses compact output.
- `--ws-log compact`: compact output (paired request/response) when verbose.
- `--ws-log full`: full per-frame output when verbose.
- `--compact`: alias for `--ws-log compact`.

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Console formatting (subsystem logging)

The console formatter is **TTY-aware** and prints consistent, prefixed lines. Subsystem loggers keep output grouped and scannable:

- **Subsystem prefixes** on every line (e.g. `[gateway]`, `[canvas]`, `[tailscale]`).
- **Subsystem colors** (stable per subsystem, hashed from the name) plus level coloring.
- **Color when output is a TTY** or the environment looks like a rich terminal (`TERM`/`COLORTERM`/`TERM_PROGRAM`); respects `NO_COLOR` and `FORCE_COLOR`.
- **Shortened subsystem prefixes**: drops a leading `gateway/`, `channels/`, or `providers/` segment, then keeps at most the last 2 remaining segments (e.g. `channels/turn/kernel` displays as `turn/kernel`). Known channel subsystems (`telegram`, `whatsapp`, `slack`, etc.) always collapse to just the channel name.
- **Sub-loggers by subsystem** (auto prefix + structured field `{ subsystem }`).
- **`logRaw()`** for QR/UX output (no prefix, no formatting).
- **Console styles**: `pretty` | `compact` | `json`.
- **Console log level** is separate from file log level (file keeps full detail when `logging.level` is `debug`/`trace`).
- **WhatsApp message bodies** log at `debug` (use `--verbose` to see them).

This keeps file logs stable while making interactive output scannable.

## Related

- [Logging](/logging)
- [OpenTelemetry export](/gateway/opentelemetry)
- [Diagnostics export](/gateway/diagnostics)
