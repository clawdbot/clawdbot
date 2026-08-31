---
summary: "Create shareable Gateway diagnostics bundles for bug reports"
title: "Diagnostics export"
read_when:
  - Preparing a bug report or support request
  - Debugging Gateway crashes, restarts, memory pressure, or oversized payloads
  - Reviewing what diagnostics data is recorded or redacted
---

OpenClaw can build a local diagnostics `.zip` for bug reports: sanitized Gateway
status, health, logs, config shape, and recent payload-free stability events.

Treat diagnostics bundles like secrets until reviewed. Payloads and credentials
are redacted by design, but the bundle still summarizes local Gateway logs and
host-level runtime state.

## Quick start

```bash
openclaw gateway diagnostics export
```

Prints the written zip path. Choose an output path:

```bash
openclaw gateway diagnostics export --output openclaw-diagnostics.zip
```

For automation:

```bash
openclaw gateway diagnostics export --json
```

## Chat command

Owners can run `/diagnostics [note]` in any conversation to request a local
Gateway export as one copy-pasteable support report:

1. Send `/diagnostics`, optionally with a short note (`/diagnostics bad tool choice`).
2. OpenClaw sends a preamble and asks for one explicit exec approval, which runs
   `openclaw gateway diagnostics export --json`. Do not approve diagnostics via
   an allow-all rule.
3. After approval, OpenClaw replies with the local bundle path, manifest
   summary, privacy notes, and relevant session ids.

In group chats, an owner can still run `/diagnostics`, but OpenClaw sends the
export result, approval prompts, and Codex session/thread breakdown to the
owner privately. The group only sees a short notice that diagnostics were sent
privately. If no private owner route exists, the command fails closed and asks
the owner to run it from a DM.

When the active session uses the native OpenAI Codex harness, the same exec
approval also covers an OpenAI feedback upload for the Codex threads OpenClaw
knows about. That upload is separate from the local Gateway zip and only
happens for Codex harness sessions. The approval prompt states that approving
also sends Codex feedback, without listing Codex session or thread ids. After
approval, the reply lists channels, OpenClaw session ids, Codex thread ids, and
local resume commands for the threads that were sent to OpenAI. Denying or
ignoring the approval skips the export, the Codex feedback upload, and the
Codex id list.

That makes the Codex debugging loop short: notice bad behavior in a channel,
run `/diagnostics`, approve once, share the report, then run the printed
`codex resume <thread-id>` command locally if you want to inspect the thread
yourself. See [Codex harness](/plugins/codex-harness#inspect-codex-threads-locally).

## What the export contains

- `summary.md`: human-readable overview for support.
- `diagnostics.json`: machine-readable summary of config, logs, status, health,
  and stability data.
- `manifest.json`: export metadata and file list.
- Sanitized config shape and non-secret config details.
- Sanitized log summaries and recent redacted log lines.
- Best-effort Gateway status and health snapshots.
- `stability/latest.json`: newest persisted stability bundle, when available.

The export is still useful when the Gateway is unhealthy: if status/health
requests fail, local logs, config shape, and the latest stability bundle are
still collected when available.

## Privacy model

Kept: subsystem names, plugin ids, provider ids, channel ids, configured
modes, status codes, durations, byte counts, queue state, memory readings,
sanitized log metadata, redacted operational messages, config shape, and
non-secret feature settings.

Omitted or redacted: chat text, prompts, instructions, webhook bodies, tool
outputs, credentials, API keys, tokens, cookies, secret values, raw
request/response bodies, account ids, message ids, raw session ids,
hostnames, and local usernames.

When a log message looks like user, chat, prompt, or tool payload text, the
export keeps only that a message was omitted plus its byte count.

## Stability recorder

The Gateway records a bounded, payload-free stability stream by default when
diagnostics are enabled. It captures operational facts, not content.

The same heartbeat also samples liveness when the event loop or CPU looks
saturated, emitting `diagnostic.liveness.warning` events with event-loop delay,
event-loop utilization, CPU-core ratio, active/waiting/queued session counts,
the current startup/runtime phase (when known), recent phase spans, and
bounded work labels. These become Gateway `warn`-level log lines only when
work is waiting or queued, or when active work overlaps sustained event-loop
delay; otherwise they log at `debug`. Idle liveness samples are still recorded
as diagnostic events but never escalate to a warning by themselves.

Startup phases emit `diagnostic.phase.completed` events with wall-clock and
CPU timing. Stalled embedded-run diagnostics mark `terminalProgressStale=true`
when the last bridge progress looked terminal (for example a raw response
item or response-completion event) but the Gateway still considers the
embedded run active.

Inspect the live recorder:

```bash
openclaw gateway stability
openclaw gateway stability --type payload.large
openclaw gateway stability --json
```

Inspect the newest persisted bundle after a fatal exit, shutdown timeout, or
restart startup failure:

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

| Flag                    | Default                                                                       | Description                                        |
| ----------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `--output <path>`       | `$OPENCLAW_STATE_DIR/logs/support/openclaw-diagnostics-<timestamp>-<pid>.zip` | Write to a specific zip path (or directory).       |
| `--log-lines <count>`   | `5000`                                                                        | Maximum sanitized log lines to include.            |
| `--log-bytes <bytes>`   | `1000000`                                                                     | Maximum log bytes to inspect.                      |
| `--url <url>`           | -                                                                             | Gateway WebSocket URL for status/health snapshots. |
| `--token <token>`       | -                                                                             | Gateway token for status/health snapshots.         |
| `--password <password>` | -                                                                             | Gateway password for status/health snapshots.      |
| `--timeout <ms>`        | `3000`                                                                        | Status/health snapshot timeout.                    |
| `--no-stability-bundle` | off                                                                           | Skip persisted stability bundle lookup.            |
| `--json`                | off                                                                           | Print machine-readable export metadata.            |

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

Disabling diagnostics reduces bug-report detail; it does not affect normal
Gateway logging.

Memory pressure events record RSS, heap, threshold, and growth facts
(`rss_threshold`, `heap_threshold`, `rss_growth`) without performing a
file-system scan or writing a pre-OOM snapshot.

## Related

- [Health checks](/gateway/health)
- [Gateway CLI](/cli/gateway#gateway-diagnostics-export)
- [Gateway protocol](/gateway/protocol#rpc-method-families)
- [Logging](/logging)
- [OpenTelemetry export](/gateway/opentelemetry) - separate flow for streaming diagnostics to a collector
