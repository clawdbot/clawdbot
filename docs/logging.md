---
summary: "Logging overview: file logs, console output, CLI tailing, and the Control UI"
read_when:
  - You need a beginner-friendly overview of logging
  - You want to configure log levels or formats
  - You are troubleshooting and need to find logs quickly
---

# Logging

Clawdbot logs in two places:

- **File logs** (JSON lines) written by the Gateway.
- **Console output** shown in terminals and the Control UI.

This page explains where logs live, how to read them, and how to configure log
levels and formats.

## Where logs live

By default, the Gateway writes a rolling log file under:

`/tmp/clawdbot/clawdbot-YYYY-MM-DD.log`

The date uses the gateway host's local timezone.

You can override this in `~/.clawdbot/clawdbot.json`:

```json
{
  "logging": {
    "file": "/path/to/clawdbot.log"
  }
}
```

## How to read logs

### CLI: live tail (recommended)

Use the CLI to tail the gateway log file via RPC:

```bash
clawdbot logs --follow
```

Output modes:

- **TTY sessions**: pretty, colorized, structured log lines.
- **Non-TTY sessions**: plain text.
- `--json`: line-delimited JSON (one log event per line).
- `--plain`: force plain text in TTY sessions.
- `--no-color`: disable ANSI colors.

In JSON mode, the CLI emits `type`-tagged objects:

- `meta`: stream metadata (file, cursor, size)
- `log`: parsed log entry
- `notice`: truncation / rotation hints
- `raw`: unparsed log line

If the Gateway is unreachable, the CLI prints a short hint to run:

```bash
clawdbot doctor
```

### Control UI (web)

The Control UI’s **Logs** tab tails the same file using `logs.tail`.
See [/web/control-ui](/web/control-ui) for how to open it.

### Channel-only logs

To filter channel activity (WhatsApp/Telegram/etc), use:

```bash
clawdbot channels logs --channel whatsapp
```

## Log formats

### File logs (JSONL)

Each line in the log file is a JSON object. The CLI and Control UI parse these
entries to render structured output (time, level, subsystem, message).

### Console output

Console logs are **TTY-aware** and formatted for readability:

- Subsystem prefixes (e.g. `gateway/channels/whatsapp`)
- Level coloring (info/warn/error)
- Optional compact or JSON mode

Console formatting is controlled by `logging.consoleStyle`.

## Configuring logging

All logging configuration lives under `logging` in `~/.clawdbot/clawdbot.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/clawdbot/clawdbot-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": [
      "sk-.*"
    ]
  }
}
```

### Log levels

- `logging.level`: **file logs** (JSONL) level.
- `logging.consoleLevel`: **console** verbosity level.

`--verbose` only affects console output; it does not change file log levels.

### Console styles

`logging.consoleStyle`:

- `pretty`: human-friendly, colored, with timestamps.
- `compact`: tighter output (best for long sessions).
- `json`: JSON per line (for log processors).

### Redaction

Tool summaries can redact sensitive tokens before they hit the console:

- `logging.redactSensitive`: `off` | `tools` (default: `tools`)
- `logging.redactPatterns`: list of regex strings to override the default set

Redaction affects **console output only** and does not alter file logs.

## Diagnostics + OpenTelemetry

Diagnostics are structured, machine-readable events for model runs **and**
message-flow telemetry (webhooks, queueing, session state). They do **not**
replace logs; they exist to feed metrics, traces, and other exporters.

Diagnostics events are emitted in-process, but exporters only attach when
diagnostics + the exporter plugin are enabled.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: the data model + SDKs for traces, metrics, and logs.
- **OTLP**: the wire protocol used to export OTel data to a collector/backend.
- Clawdbot exports via **OTLP/HTTP (protobuf)** today.

### Signals exported

- **Metrics**: counters + histograms (token usage, message flow, queueing).
- **Traces**: spans for model usage + webhook/message processing.
- **Logs**: exported over OTLP when `diagnostics.otel.logs` is enabled. Log
  volume can be high; keep `logging.level` and exporter filters in mind.

### Diagnostic event catalog

Model usage:
- `model.usage`: tokens, cost, duration, context, provider/model/channel, session ids.

Message flow:
- `webhook.received`: webhook ingress per channel.
- `webhook.processed`: webhook handled + duration.
- `webhook.error`: webhook handler errors.
- `message.queued`: message enqueued for processing.
- `message.processed`: outcome + duration + optional error.

Queue + session:
- `queue.lane.enqueue`: command queue lane enqueue + depth.
- `queue.lane.dequeue`: command queue lane dequeue + wait time.
- `session.state`: session state transition + reason.
- `session.stuck`: session stuck warning + age.
- `run.attempt`: run retry/attempt metadata.
- `diagnostic.heartbeat`: aggregate counters (webhooks/queue/session).

### Enable diagnostics (no exporter)

Use this if you want diagnostics events available to plugins or custom sinks:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Export to OpenTelemetry

Diagnostics can be exported via the `diagnostics-otel` plugin (OTLP/HTTP). This
works with any OpenTelemetry collector/backend that accepts OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "clawdbot-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Notes:
- You can also enable the plugin with `clawdbot plugins enable diagnostics-otel`.
- `protocol` currently supports `http/protobuf` only. `grpc` is ignored.
- Metrics include token usage, cost, context size, run duration, and message-flow
  counters/histograms (webhooks, queueing, session state, queue depth/wait).
- Traces/metrics can be toggled with `traces` / `metrics` (default: on). Traces
  include model usage spans plus webhook/message processing spans when enabled.
- Set `headers` when your collector requires auth.
- Environment variables supported: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Exported metrics (names + types)

Model usage:
- `clawdbot.tokens` (counter, attrs: `clawdbot.token`, `clawdbot.channel`,
  `clawdbot.provider`, `clawdbot.model`)
- `clawdbot.cost.usd` (counter, attrs: `clawdbot.channel`, `clawdbot.provider`,
  `clawdbot.model`)
- `clawdbot.run.duration_ms` (histogram, attrs: `clawdbot.channel`,
  `clawdbot.provider`, `clawdbot.model`)
- `clawdbot.context.tokens` (histogram, attrs: `clawdbot.context`,
  `clawdbot.channel`, `clawdbot.provider`, `clawdbot.model`)

Message flow:
- `clawdbot.webhook.received` (counter, attrs: `clawdbot.channel`,
  `clawdbot.webhook`)
- `clawdbot.webhook.error` (counter, attrs: `clawdbot.channel`,
  `clawdbot.webhook`)
- `clawdbot.webhook.duration_ms` (histogram, attrs: `clawdbot.channel`,
  `clawdbot.webhook`)
- `clawdbot.message.queued` (counter, attrs: `clawdbot.channel`,
  `clawdbot.source`)
- `clawdbot.message.processed` (counter, attrs: `clawdbot.channel`,
  `clawdbot.outcome`)
- `clawdbot.message.duration_ms` (histogram, attrs: `clawdbot.channel`,
  `clawdbot.outcome`)

Queues + sessions:
- `clawdbot.queue.lane.enqueue` (counter, attrs: `clawdbot.lane`)
- `clawdbot.queue.lane.dequeue` (counter, attrs: `clawdbot.lane`)
- `clawdbot.queue.depth` (histogram, attrs: `clawdbot.lane` or
  `clawdbot.channel=heartbeat`)
- `clawdbot.queue.wait_ms` (histogram, attrs: `clawdbot.lane`)
- `clawdbot.session.state` (counter, attrs: `clawdbot.state`, `clawdbot.reason`)
- `clawdbot.session.stuck` (counter, attrs: `clawdbot.state`)
- `clawdbot.session.stuck_age_ms` (histogram, attrs: `clawdbot.state`)
- `clawdbot.run.attempt` (counter, attrs: `clawdbot.attempt`)

### Exported spans (names + key attributes)

- `clawdbot.model.usage`
  - `clawdbot.channel`, `clawdbot.provider`, `clawdbot.model`
  - `clawdbot.sessionKey`, `clawdbot.sessionId`
  - `clawdbot.tokens.*` (input/output/cache_read/cache_write/total)
- `clawdbot.webhook.processed`
  - `clawdbot.channel`, `clawdbot.webhook`, `clawdbot.chatId`
- `clawdbot.webhook.error`
  - `clawdbot.channel`, `clawdbot.webhook`, `clawdbot.chatId`,
    `clawdbot.error`
- `clawdbot.message.processed`
  - `clawdbot.channel`, `clawdbot.outcome`, `clawdbot.chatId`,
    `clawdbot.messageId`, `clawdbot.sessionKey`, `clawdbot.sessionId`,
    `clawdbot.reason`
- `clawdbot.session.stuck`
  - `clawdbot.state`, `clawdbot.ageMs`, `clawdbot.queueDepth`,
    `clawdbot.sessionKey`, `clawdbot.sessionId`

### Sampling + flushing

- Trace sampling: `diagnostics.otel.sampleRate` (0.0–1.0, root spans only).
- Metric export interval: `diagnostics.otel.flushIntervalMs` (min 1000ms).

### Protocol notes

- OTLP/HTTP endpoints can be set via `diagnostics.otel.endpoint` or
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- If the endpoint already contains `/v1/traces` or `/v1/metrics`, it is used as-is.
- If the endpoint already contains `/v1/logs`, it is used as-is for logs.
- `diagnostics.otel.logs` enables OTLP log export for the main logger output.

### Log export behavior

- OTLP logs use the same structured records written to `logging.file`.
- Respect `logging.level` (file log level). Console redaction does **not** apply
  to OTLP logs.
- High-volume installs should prefer OTLP collector sampling/filtering.

## Troubleshooting tips

- **Gateway not reachable?** Run `clawdbot doctor` first.
- **Logs empty?** Check that the Gateway is running and writing to the file path
  in `logging.file`.
- **Need more detail?** Set `logging.level` to `debug` or `trace` and retry.
