---
summary: "Create shareable Gateway diagnostics bundles for bug reports"
title: "Diagnostics export"
read_when:
  - Preparing a bug report or support request
  - Debugging Gateway crashes, restarts, memory pressure, or oversized payloads
  - Reviewing what diagnostics data is recorded or redacted
---

OpenClaw can create a local diagnostics zip that is safe to attach to bug
reports. It combines sanitized Gateway status, health, logs, config shape, and
recent payload-free stability events.

## Quick start

```bash
openclaw gateway diagnostics export
```

The command prints the written zip path. To choose a path:

```bash
openclaw gateway diagnostics export --output openclaw-diagnostics.zip
```

For automation:

```bash
openclaw gateway diagnostics export --json
```

## What the export contains

The zip includes:

- `summary.md`: human-readable overview for support.
- `diagnostics.json`: machine-readable summary of config, logs, status, health,
  and stability data.
- `manifest.json`: export metadata and file list.
- Sanitized config shape and non-secret config details.
- Sanitized log summaries and recent redacted log lines.
- Best-effort Gateway status and health snapshots.
- `stability/latest.json`: newest persisted stability bundle, when available.

The export is useful even when the Gateway is unhealthy. If the Gateway cannot
answer status or health requests, the local logs, config shape, and latest
stability bundle are still collected when available.

## Privacy model

Diagnostics are designed to be shareable. The export keeps operational data
that helps debugging, such as:

- subsystem names, plugin ids, provider ids, channel ids, and configured modes
- status codes, durations, byte counts, queue state, and memory readings
- sanitized log metadata and redacted operational messages
- config shape and non-secret feature settings

The export omits or redacts:

- chat text, prompts, instructions, webhook bodies, and tool outputs
- credentials, API keys, tokens, cookies, and secret values
- raw request or response bodies
- account ids, message ids, raw session ids, hostnames, and local usernames

When a log message looks like user, chat, prompt, or tool payload text, the
export keeps only that a message was omitted and the byte count.

## Stability recorder

The Gateway records a bounded, payload-free stability stream by default when
diagnostics are enabled. It is for operational facts, not content.

Inspect the live recorder:

```bash
openclaw gateway stability
openclaw gateway stability --type payload.large
openclaw gateway stability --json
```

Inspect the newest persisted stability bundle after a fatal exit, shutdown
timeout, or restart startup failure:

```bash
openclaw gateway stability --bundle latest
```

Create a diagnostics zip from the newest persisted bundle:

```bash
openclaw gateway stability --bundle latest --export
```

Persisted bundles live under `~/.openclaw/logs/stability/` when events exist.

## Useful options

```bash
openclaw gateway diagnostics export \
  --output openclaw-diagnostics.zip \
  --log-lines 5000 \
  --log-bytes 1000000
```

- `--output <path>`: write to a specific zip path.
- `--log-lines <count>`: maximum sanitized log lines to include.
- `--log-bytes <bytes>`: maximum log bytes to inspect.
- `--url <url>`: Gateway WebSocket URL for status and health snapshots.
- `--token <token>`: Gateway token for status and health snapshots.
- `--password <password>`: Gateway password for status and health snapshots.
- `--timeout <ms>`: status and health snapshot timeout.
- `--no-stability-bundle`: skip persisted stability bundle lookup.
- `--json`: print machine-readable export metadata.

## Disable diagnostics

Diagnostics are enabled by default. To disable the stability recorder and
diagnostic event collection:

```json5
{
  diagnostics: {
    enabled: false,
  },
}
```

Disabling diagnostics reduces bug-report detail. It does not affect normal
Gateway logging.

## Related

- [Health checks](/gateway/health)
- [Gateway CLI](/cli/gateway#gateway-diagnostics-export)
- [Gateway protocol](/gateway/protocol#system-and-identity)
- [Logging](/logging)
- [OpenTelemetry export](/gateway/opentelemetry) — separate flow for streaming diagnostics to a collector
