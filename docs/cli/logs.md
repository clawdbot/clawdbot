---
summary: "CLI reference for `openclaw logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "Logs"
---

# `openclaw logs`

Tail Gateway file logs over RPC. Works in remote mode.

## Options

- `--limit <n>`: max log lines to return (default `200`)
- `--max-bytes <n>`: max bytes to read from the log file (default `250000`)
- `--follow`: follow the log stream
- `--interval <ms>`: polling interval while following (default `1000`)
- `--json`: emit line-delimited JSON events
- `--plain`: plain text output without styled formatting
- `--no-color`: disable ANSI colors
- `--local-time`: render timestamps in your local timezone (default)
- `--utc`: render timestamps in UTC

## Shared Gateway RPC options

- `--url <url>`: Gateway WebSocket URL
- `--token <token>`: Gateway token
- `--timeout <ms>`: timeout in ms (default `30000`)
- `--expect-final`: wait for a final response when the Gateway call is agent-backed

Passing `--url` skips auto-applied config credentials; include `--token` explicitly if the target Gateway requires auth.

## Examples

```bash
openclaw logs
openclaw logs --follow
openclaw --dev logs --follow
openclaw --profile work logs --follow
openclaw logs --follow --interval 2000
openclaw logs --limit 500 --max-bytes 500000
openclaw logs --json
openclaw logs --plain
openclaw logs --no-color
openclaw logs --utc
openclaw logs --follow --local-time
openclaw logs --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
```

The selected root profile matches the Gateway's rolling file: the default
profile uses `openclaw-YYYY-MM-DD.log`, while named profiles use
`openclaw-<profile>-YYYY-MM-DD.log` (for example,
`openclaw-dev-YYYY-MM-DD.log`).

## Fallback and recovery behavior

- If the implicit local loopback Gateway asks for pairing, closes during connect, or times out before `logs.tail` answers, `openclaw logs` falls back to the configured Gateway file log automatically. Explicit `--url` targets never use this fallback.
- `--follow` does not fall back to that configured file after an implicit local Gateway RPC failure — a stale side-by-side file could mislead a live tail. On Linux it instead uses the active user-systemd Gateway journal by PID when available (prints the selected source); otherwise it keeps retrying the live Gateway.
- During `--follow`, transient disconnects (WebSocket close, timeout, connection drop) trigger automatic reconnection with exponential backoff: up to 8 retries, capped at 30s between attempts. A warning prints to stderr on each retry, and a `[logs] gateway reconnected` notice prints once a poll succeeds. In `--json` mode both are emitted as `{"type":"notice"}` records on stderr. Non-recoverable errors (auth failure, bad configuration) still exit immediately.
- In `--follow --json` mode, log-source transitions are emitted as `{"type":"meta"}` records. Track cursors per `sourceKind`: a stream can move from Gateway file output (`sourceKind: "file"`) to local journal fallback (`sourceKind: "journal"`, `localFallback: true`, with `service.pid`/`service.unit`) and back to Gateway file output after recovery. Do not assume one stable source or cursor for the whole session, and tolerate overlapping lines when recovery replays the Gateway file cursor.

## Related

- [Logging overview](/logging)
- [Gateway CLI](/cli/gateway)
- [CLI reference](/cli)
- [Gateway logging](/gateway/logging)
