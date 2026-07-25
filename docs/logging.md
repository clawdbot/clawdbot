---
summary: "File logs, console output, CLI tailing, and the Control UI Logs tab"
read_when:
  - You need a beginner-friendly overview of OpenClaw logging
  - You want to configure log levels, formats, or redaction
  - You are troubleshooting and need to find logs quickly
title: "Logging"
---

OpenClaw has two main log surfaces:

- **File logs** (JSON lines) written by the Gateway.
- **Console output** in the terminal running the Gateway.

The Control UI **Logs** tab tails the gateway file log. This page explains where
logs live, how to read them, and how to configure log levels and formats.

## Where logs live

By default, the Gateway writes a rolling log file per day. The default profile
keeps the historical path:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Named profiles use a profile-qualified filename in the same directory:

`/tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log`

The filename profile segment is lowercase and limited to letters, numbers, and
dashes. Simple lowercase names stay readable, so the `--dev` shorthand writes
`openclaw-dev-YYYY-MM-DD.log`. Case, underscores, and literal dashes use a
reversible dash escape so distinct profile names never share a log file.
Oversized values set directly through the environment use a bounded hash suffix
to stay within filesystem filename limits. An explicit `logging.file` overrides
these defaults.

The date uses the gateway host's local timezone. When `/tmp/openclaw` is unsafe
or unavailable (and always on Windows), OpenClaw uses a user-scoped
`openclaw-<uid>` directory under the OS temp dir instead. Dated log files are
pruned after 24 hours.

Each file rotates when the next write would exceed `logging.maxFileBytes`
(default: 100 MB). OpenClaw keeps up to five numbered archives beside the
active file, such as `openclaw-YYYY-MM-DD.1.log` or
`openclaw-dev-YYYY-MM-DD.1.log`, and keeps writing to a fresh active log instead
of suppressing diagnostics.

You can override the path in `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## How to read logs

### CLI: live tail (recommended)

Tail the gateway log file via RPC:

```bash
openclaw logs --follow
openclaw --dev logs --follow
openclaw --profile work logs --follow
```

The root profile selector resolves the same profile-specific file used by the
Gateway, including CLI fallback reads when local RPC is unavailable.

Options:

| Flag                | Default  | Behavior                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------- |
| `--follow`          | off      | Keep tailing; reconnects with backoff on disconnect                                   |
| `--limit <n>`       | `200`    | Max lines per fetch                                                                   |
| `--max-bytes <n>`   | `250000` | Max bytes to read per fetch                                                           |
| `--interval <ms>`   | `1000`   | Poll interval while following                                                         |
| `--json`            | off      | Line-delimited JSON (one event per line)                                              |
| `--plain`           | off      | Force plain text in TTY sessions                                                      |
| `--no-color`        | —        | Disable ANSI colors                                                                   |
| `--utc`             | off      | Render timestamps in UTC (local time is default)                                      |
| `--local-time`      | off      | Accepted compatibility spelling for the local-time default; no effect beyond it       |
| `--url` / `--token` | —        | Standard Gateway RPC flags                                                            |
| `--timeout <ms>`    | `30000`  | Gateway RPC timeout                                                                   |
| `--expect-final`    | off      | Agent-backed RPC final-response wait flag (accepted here via the shared client layer) |

Output modes:

- **TTY sessions**: pretty, colorized, structured log lines.
- **Non-TTY sessions**: plain text.

When you pass an explicit `--url`, the CLI does not auto-apply config or
environment credentials; include `--token` yourself, or the call fails with
`gateway url override requires explicit credentials`.

In JSON mode, the CLI emits `type`-tagged objects:

- `meta`: stream metadata (file, source, sourceKind, service, cursor, size)
- `log`: parsed log entry
- `notice`: truncation / rotation hints
- `raw`: unparsed log line
- `error`: gateway connection failures (written to stderr)

If the implicit local loopback Gateway asks for pairing, closes during connect,
or times out before `logs.tail` answers, `openclaw logs` falls back to the
configured Gateway file log automatically. Explicit `--url` targets do not use
this fallback. `openclaw logs --follow` is stricter: on Linux it uses the active
user-systemd Gateway journal by PID when available, and otherwise retries the
live Gateway with backoff instead of following a potentially stale side-by-side
file.

If the Gateway is unreachable, the CLI prints a short hint to run:

```bash
openclaw doctor
```

### Control UI (web)

The Control UI's **Logs** tab tails the same file using `logs.tail`.
See [Control UI](/web/control-ui) for how to open it.

### Channel-only logs

To filter channel activity (WhatsApp/Telegram/etc), use:

```bash
openclaw channels logs --channel whatsapp
```

`--channel` defaults to `all`; `--lines <n>` (default 200) and `--json` are also
available.

## Log formats

### File logs (JSONL)

Each line in the log file is a JSON object. The CLI and Control UI parse these
entries to render structured output (time, level, subsystem, message).

File-log JSONL records also include machine-filterable top-level fields when
available:

- `hostname`: gateway host name.
- `message`: flattened log message text for full-text search.
- `agent_id`: active agent id when the log call carries agent context.
- `session_id`: active session id/key when the log call carries session context.
- `channel`: active channel when the log call carries channel context.

OpenClaw preserves the original structured log arguments alongside these fields
so existing parsers that read numbered tslog argument keys keep working.

Talk, realtime voice, and managed-room activity emits bounded lifecycle log
records through this same file-log pipeline. These records include event type,
mode, transport, provider, and size/timing measurements when available, but omit
transcript text, audio payloads, turn ids, call ids, and provider item ids.

### Console output

Console logs are **TTY-aware** and formatted for readability:

- Subsystem prefixes (e.g. `gateway/channels/whatsapp`)
- Level coloring (info/warn/error)
- Optional compact or JSON mode

Console formatting is controlled by `logging.consoleStyle`.

### Gateway WebSocket logs

`openclaw gateway` also has WebSocket protocol logging for RPC traffic:

- normal mode: only interesting results (errors, parse errors, slow calls)
- `--verbose`: all request/response traffic
- `--ws-log auto|compact|full`: pick the verbose rendering style
- `--compact`: alias for `--ws-log compact`

Examples:

```bash
openclaw gateway
openclaw gateway --verbose --ws-log compact
openclaw gateway --verbose --ws-log full
```

## Configuring logging

All logging configuration lives under `logging` in `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/path/to/openclaw.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Log levels

Levels: `silent`, `fatal`, `error`, `warn`, `info`, `debug`, `trace`.

- `logging.level`: **file logs** (JSONL) level (default: `info`).
- `logging.consoleLevel`: **console** verbosity level.

You can override both via the **`OPENCLAW_LOG_LEVEL`** environment variable (e.g. `OPENCLAW_LOG_LEVEL=debug`). The env var takes precedence over the config file, so you can raise verbosity for a single run without editing `openclaw.json`. You can also pass the global CLI option **`--log-level <level>`** (for example, `openclaw --log-level debug gateway run`), which overrides the environment variable for that command.

`--verbose` only affects console output and WS log verbosity; it does not change
file log levels.

### Targeted model transport diagnostics

When debugging provider calls, use targeted environment flags instead of raising
all logs to `debug`:

```bash
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 openclaw gateway
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools OPENCLAW_DEBUG_SSE=events openclaw gateway
```

Available flags:

- `OPENCLAW_DEBUG_MODEL_TRANSPORT=1`: emit request start, fetch response, SDK
  headers, first streaming event, stream completion, and transport errors at
  `info` level.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=summary`: include a bounded request payload
  summary in model request logs.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=tools`: include all model-facing tool names in
  the payload summary.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted`: include a redacted, capped JSON
  payload snapshot. Use only while debugging; secrets are redacted but prompts
  and message text may still be present.
- `OPENCLAW_DEBUG_SSE=events`: emit first-event and stream-completion timing.
- `OPENCLAW_DEBUG_SSE=peek`: also emit the first five redacted SSE event
  payloads, capped per event.
- `OPENCLAW_DEBUG_CODE_MODE=1`: emit code-mode model-surface diagnostics,
  including when native provider tools are hidden because code mode owns the
  tool surface.

These flags log through normal OpenClaw logging, so `openclaw logs --follow`
and the Control UI Logs tab show them. Without the flags, the same diagnostics
remain available at `debug` level.

`[model-fetch]` start and response metadata (provider, API, model, status,
latency, and request fields such as method, URL, timeout, proxy, and policy)
is always emitted at `info` level regardless of
`OPENCLAW_DEBUG_MODEL_TRANSPORT`, so basic model transport hygiene is visible
without debug flags.

### Trace correlation

File logs are JSONL. When a log call carries a valid diagnostic trace context,
OpenClaw writes the trace fields as top-level JSON keys (`traceId`, `spanId`,
`parentSpanId`, `traceFlags`) so external log processors can correlate the line
with OTEL spans and provider `traceparent` propagation.

Gateway HTTP requests and Gateway WebSocket frames establish an internal request
trace scope. Logs and diagnostic events emitted inside that async scope inherit
the request trace when they do not pass an explicit trace context. Agent run and
model-call traces become children of the active request trace, so local logs,
diagnostic snapshots, OTEL spans, and trusted provider `traceparent` headers can
be joined by `traceId` without logging raw request or model content.

Talk lifecycle log records also flow to diagnostics-otel log export when
OpenTelemetry log export is enabled, using the same bounded attributes as file
logs. Configure `diagnostics.otel.logsExporter` to choose OTLP, stdout JSONL, or
both sinks.

### Model call size and timing

Model-call diagnostics record bounded request/response measurements without
capturing raw prompt or response content:

- `requestPayloadBytes`: UTF-8 byte size of the final model request payload
- `responseStreamBytes`: UTF-8 byte size of streamed model response chunk
  payloads. High-frequency text, thinking, and tool-call delta events count
  only the incremental `delta` bytes instead of full `partial` snapshots.
- `timeToFirstByteMs`: elapsed time before the first streamed response event
- `durationMs`: total model-call duration

These fields are available to diagnostic snapshots, model-call plugin hooks, and
OTEL model-call spans/metrics when diagnostics export is enabled.

### Console styles

`logging.consoleStyle`:

- `pretty`: human-friendly, colored, with timestamps.
- `compact`: tighter output (best for long sessions).
- `json`: JSON per line (for log processors).

### Redaction

OpenClaw can redact sensitive tokens before they hit console output, file logs,
OTLP log records, persisted session transcript text, or Control UI tool
event payloads (tool start args, partial/final result payloads, derived
exec output, and patch summaries):

- Sensitive-value redaction is always enabled.
- `logging.redactPatterns`: list of regex strings that replaces the default set for log/transcript output. For Control UI tool payloads, custom patterns apply on top of the built-in defaults, so adding a pattern never weakens redaction of values already caught by the defaults.

File logs and session transcripts stay JSONL, but matching secret values are
masked before the line or message is written to disk. Redaction is best-effort:
it applies to text-bearing message content and log strings, not every
identifier or binary payload field.

The built-in defaults cover common API credentials and payment-credential field
names such as card number, CVC/CVV, shared payment token, and payment credential
when they appear as JSON fields, URL parameters, CLI flags, or assignments.

OpenClaw also redacts safety-boundary payloads shown to UI clients, support
bundles, diagnostics observers, approval prompts, or agent tools. Custom
`logging.redactPatterns` can add project-specific patterns on those surfaces.

## Diagnostics and OpenTelemetry

Diagnostics are structured, machine-readable events for model runs and
message-flow telemetry (webhooks, queueing, session state). They do **not**
replace logs — they feed metrics, traces, and exporters. Events are emitted
in-process by default (set `diagnostics.enabled: false` to turn them off);
exporting them is separate.

Two adjacent surfaces:

- **OpenTelemetry export** — send metrics, traces, and logs over OTLP/HTTP to
  any OpenTelemetry-compatible collector or backend (Datadog, Grafana,
  Honeycomb, New Relic, Tempo, etc.). Full configuration, signal catalog,
  metric/span names, env vars, and privacy model live on a dedicated page:
  [OpenTelemetry export](/gateway/opentelemetry).
- **Diagnostics flags** — targeted debug-log flags that route extra logs to
  `logging.file` without raising `logging.level`. Flags are case-insensitive
  and support wildcards (`telegram.*`, `*`). Configure under `diagnostics.flags`
  or via the `OPENCLAW_DIAGNOSTICS=...` env override. Full guide:
  [Diagnostics flags](/diagnostics/flags).

For OTLP export to a collector, see [OpenTelemetry export](/gateway/opentelemetry).

## Troubleshooting tips

- **Gateway not reachable?** Run `openclaw doctor` first.
- **Logs empty?** Check that the Gateway is running and writing to the file path
  in `logging.file`.
- **Need more detail?** Set `logging.level` to `debug` or `trace` and retry.

## Related

- [OpenTelemetry export](/gateway/opentelemetry) — OTLP/HTTP export, metric/span catalog, privacy model
- [Diagnostics flags](/diagnostics/flags) — targeted debug-log flags
- [Gateway logging internals](/gateway/logging) — WS log styles, subsystem prefixes, and console capture
- [Configuration reference](/gateway/configuration-reference#diagnostics) — full `diagnostics.*` field reference
