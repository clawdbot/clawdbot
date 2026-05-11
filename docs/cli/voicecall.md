---
summary: "CLI reference for `openclaw voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want every CLI entry point
  - You need flag tables and defaults for setup, smoke, call, continue, speak, dtmf, end, status, tail, latency, expose, and start
title: "Voicecall"
---

# `openclaw voicecall`

`voicecall` is a plugin-provided command. It only appears when the voice-call plugin is installed and enabled.

When the Gateway is running, operational commands (`call`, `start`, `continue`, `speak`, `dtmf`, `end`, `status`) are routed to that Gateway's voice-call runtime. If no Gateway is reachable, they fall back to a standalone CLI runtime.

## Subcommands

```bash
openclaw voicecall setup    [--json]
openclaw voicecall smoke    [-t <phone>] [--message <text>] [--mode <m>] [--yes] [--json]
openclaw voicecall call     -m <text> [-t <phone>] [--mode <m>]
openclaw voicecall start    --to <phone> [--message <text>] [--mode <m>]
openclaw voicecall continue --call-id <id> --message <text>
openclaw voicecall speak    --call-id <id> --message <text>
openclaw voicecall dtmf     --call-id <id> --digits <digits>
openclaw voicecall end      --call-id <id>
openclaw voicecall status   [--call-id <id>] [--json]
openclaw voicecall tail     [--file <path>] [--since <n>] [--poll <ms>]
openclaw voicecall latency  [--file <path>] [--last <n>]
openclaw voicecall expose   [--mode <m>] [--path <p>] [--port <port>] [--serve-path <p>]
```

| Subcommand | Description                                                     |
| ---------- | --------------------------------------------------------------- |
| `setup`    | Show provider and webhook readiness checks.                     |
| `smoke`    | Run readiness checks; place a live test call only with `--yes`. |
| `call`     | Initiate an outbound voice call.                                |
| `start`    | Alias for `call` with `--to` required and `--message` optional. |
| `continue` | Speak a message and wait for the next response.                 |
| `speak`    | Speak a message without waiting for a response.                 |
| `dtmf`     | Send DTMF digits to an active call.                             |
| `end`      | Hang up an active call.                                         |
| `status`   | Inspect active calls (or one by `--call-id`).                   |
| `tail`     | Tail `calls.jsonl` (useful during provider tests).              |
| `latency`  | Summarize turn-latency metrics from `calls.jsonl`.              |
| `expose`   | Toggle Tailscale serve/funnel for the webhook endpoint.         |

## Setup and smoke

### `setup`

Prints human-readable readiness checks by default. Pass `--json` for scripts.

```bash
openclaw voicecall setup
openclaw voicecall setup --json
```

### `smoke`

Runs the same readiness checks. It will not place a real phone call unless both `--to` and `--yes` are present.

| Flag               | Default                           | Description                             |
| ------------------ | --------------------------------- | --------------------------------------- |
| `-t, --to <phone>` | (none)                            | Phone number to call for a live smoke.  |
| `--message <text>` | `OpenClaw voice call smoke test.` | Message to speak during the smoke call. |
| `--mode <mode>`    | `notify`                          | Call mode: `notify` or `conversation`.  |
| `--yes`            | `false`                           | Actually place the live outbound call.  |
| `--json`           | `false`                           | Print machine-readable JSON.            |

```bash
openclaw voicecall smoke
openclaw voicecall smoke --to "+15555550123"        # dry run
openclaw voicecall smoke --to "+15555550123" --yes  # live notify call
```

<Note>
For external providers (`twilio`, `telnyx`, `plivo`), `setup` and `smoke` require a public webhook URL from `publicUrl`, a tunnel, or Tailscale exposure. A loopback or private serve fallback is rejected because carriers cannot reach it.
</Note>

## Call lifecycle

### `call`

Initiate an outbound voice call.

| Flag                   | Required | Default           | Description                                                                |
| ---------------------- | -------- | ----------------- | -------------------------------------------------------------------------- |
| `-m, --message <text>` | yes      | (none)            | Message to speak when the call connects.                                   |
| `-t, --to <phone>`     | no       | config `toNumber` | E.164 phone number to call.                                                |
| `--mode <mode>`        | no       | `conversation`    | Call mode: `notify` (hang up after message) or `conversation` (stay open). |

```bash
openclaw voicecall call --to "+15555550123" --message "Hello"
openclaw voicecall call -m "Heads up" --mode notify
```

### `start`

Alias for `call` with a different default flag shape.

| Flag               | Required | Default        | Description                              |
| ------------------ | -------- | -------------- | ---------------------------------------- |
| `--to <phone>`     | yes      | (none)         | Phone number to call.                    |
| `--message <text>` | no       | (none)         | Message to speak when the call connects. |
| `--mode <mode>`    | no       | `conversation` | Call mode: `notify` or `conversation`.   |

### `continue`

Speak a message and wait for a response.

| Flag               | Required | Description       |
| ------------------ | -------- | ----------------- |
| `--call-id <id>`   | yes      | Call ID.          |
| `--message <text>` | yes      | Message to speak. |

### `speak`

Speak a message without waiting for a response.

| Flag               | Required | Description       |
| ------------------ | -------- | ----------------- |
| `--call-id <id>`   | yes      | Call ID.          |
| `--message <text>` | yes      | Message to speak. |

### `dtmf`

Send DTMF digits to an active call.

| Flag                | Required | Description                               |
| ------------------- | -------- | ----------------------------------------- |
| `--call-id <id>`    | yes      | Call ID.                                  |
| `--digits <digits>` | yes      | DTMF digits (e.g. `ww123456#` for waits). |

### `end`

Hang up an active call.

| Flag             | Required | Description |
| ---------------- | -------- | ----------- |
| `--call-id <id>` | yes      | Call ID.    |

### `status`

Inspect active calls.

| Flag             | Default | Description                  |
| ---------------- | ------- | ---------------------------- |
| `--call-id <id>` | (none)  | Restrict output to one call. |
| `--json`         | `false` | Print machine-readable JSON. |

```bash
openclaw voicecall status
openclaw voicecall status --json
openclaw voicecall status --call-id <id>
```

## Logs and metrics

### `tail`

Tail the voice-call JSONL log. Prints the last `--since` lines on start, then streams new lines as they are written.

| Flag            | Default                    | Description                    |
| --------------- | -------------------------- | ------------------------------ |
| `--file <path>` | resolved from plugin store | Path to `calls.jsonl`.         |
| `--since <n>`   | `25`                       | Lines to print before tailing. |
| `--poll <ms>`   | `250` (minimum 50)         | Poll interval in milliseconds. |

### `latency`

Summarize turn-latency and listen-wait metrics from `calls.jsonl`. Output is JSON with `recordsScanned`, `turnLatency`, and `listenWait` summaries.

| Flag            | Default                    | Description                          |
| --------------- | -------------------------- | ------------------------------------ |
| `--file <path>` | resolved from plugin store | Path to `calls.jsonl`.               |
| `--last <n>`    | `200` (minimum 1)          | Number of recent records to analyze. |

## Exposing webhooks

### `expose`

Enable, disable, or change the Tailscale serve/funnel configuration for the voice webhook.

| Flag                  | Default                                   | Description                                     |
| --------------------- | ----------------------------------------- | ----------------------------------------------- |
| `--mode <mode>`       | `funnel`                                  | `off`, `serve` (tailnet), or `funnel` (public). |
| `--path <path>`       | config `tailscale.path` or `--serve-path` | Tailscale path to expose.                       |
| `--port <port>`       | config `serve.port` or `3334`             | Local webhook port.                             |
| `--serve-path <path>` | config `serve.path` or `/voice/webhook`   | Local webhook path.                             |

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall expose --mode off
```

<Warning>
Only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
</Warning>

## Related

- [CLI reference](/cli)
- [Voice call plugin](/plugins/voice-call)
