---
summary: "CLI reference for `openclaw webhooks` (Gmail Pub/Sub setup and runner)"
read_when:
  - You want to wire Gmail Pub/Sub events into OpenClaw
  - You need the full flag list and default values
title: "Webhooks"
---

# `openclaw webhooks`

Webhook helpers and integrations. Today this surface is scoped to Gmail Pub/Sub flows that integrate with the bundled `gog` watcher.

## Subcommands

```bash
openclaw webhooks gmail setup --account <email> [...]
openclaw webhooks gmail run   [--account <email>] [...]
```

| Subcommand    | Description                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------- |
| `gmail setup` | Configure Gmail watch, Pub/Sub topic/subscription, and the OpenClaw webhook delivery target. |
| `gmail run`   | Run `gog watch serve` plus the watch auto-renew loop.                                        |

## `webhooks gmail setup`

Configure Gmail watch, Pub/Sub, and OpenClaw webhook delivery.

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail setup --account you@example.com --project my-gcp-project --json
openclaw webhooks gmail setup --account you@example.com --hook-url https://gateway.example.com/hooks/gmail
```

### Required

| Flag                | Description             |
| ------------------- | ----------------------- |
| `--account <email>` | Gmail account to watch. |

### Pub/Sub options

| Flag                    | Default                | Description                                          |
| ----------------------- | ---------------------- | ---------------------------------------------------- |
| `--project <id>`        | (none)                 | GCP project id (the OAuth client owner).             |
| `--topic <name>`        | `gog-gmail-watch`      | Pub/Sub topic name.                                  |
| `--subscription <name>` | `gog-gmail-watch-push` | Pub/Sub subscription name.                           |
| `--label <label>`       | `INBOX`                | Gmail label to watch.                                |
| `--push-endpoint <url>` | (none)                 | Explicit Pub/Sub push endpoint. Overrides Tailscale. |

### OpenClaw delivery options

| Flag                   | Default | Description                                |
| ---------------------- | ------- | ------------------------------------------ |
| `--hook-url <url>`     | (none)  | OpenClaw webhook URL.                      |
| `--hook-token <token>` | (none)  | OpenClaw webhook token.                    |
| `--push-token <token>` | (none)  | Push token forwarded to `gog watch serve`. |

### `gog watch serve` options

| Flag                  | Default         | Description                                                       |
| --------------------- | --------------- | ----------------------------------------------------------------- |
| `--bind <host>`       | `127.0.0.1`     | `gog watch serve` bind host.                                      |
| `--port <port>`       | `8788`          | `gog watch serve` port.                                           |
| `--path <path>`       | `/gmail-pubsub` | `gog watch serve` path.                                           |
| `--include-body`      | `true`          | Include email body snippets. Pass `--no-include-body` to disable. |
| `--max-bytes <n>`     | `20000`         | Max bytes per body snippet.                                       |
| `--renew-minutes <n>` | `720` (12h)     | Renew Gmail watch every N minutes.                                |

### Tailscale exposure

| Flag                      | Default  | Description                                                      |
| ------------------------- | -------- | ---------------------------------------------------------------- |
| `--tailscale <mode>`      | `funnel` | Expose push endpoint via tailscale: `funnel`, `serve`, or `off`. |
| `--tailscale-path <path>` | (none)   | Path for tailscale serve/funnel.                                 |
| `--tailscale-target <t>`  | (none)   | Tailscale serve/funnel target (port, `host:port`, or URL).       |

### Output

| Flag     | Description                                       |
| -------- | ------------------------------------------------- |
| `--json` | Print a machine-readable summary instead of text. |

## `webhooks gmail run`

Run `gog watch serve` plus the watch auto-renew loop in the foreground.

```bash
openclaw webhooks gmail run --account you@example.com
```

`run` accepts the same `gog watch serve`, OpenClaw delivery, Pub/Sub, and Tailscale flags as `setup`, except:

- `--account` is **optional** on `run` (it falls back to the configured account).
- `run` does **not** accept `--project`, `--push-endpoint`, or `--json`.
- `run` flags have no built-in defaults; missing values fall back to the values written by `setup`.

| Category          | Flags                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Pub/Sub           | `--account`, `--topic`, `--subscription`, `--label`                              |
| OpenClaw delivery | `--hook-url`, `--hook-token`, `--push-token`                                     |
| `gog watch serve` | `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes` |
| Tailscale         | `--tailscale`, `--tailscale-path`, `--tailscale-target`                          |

<Note>
For `run`, the `--topic` value is the full Pub/Sub topic path (`projects/.../topics/...`), not just the short topic name.
</Note>

## End-to-end flow

See [Gmail Pub/Sub integration](/automation/cron-jobs#gmail-pubsub-integration) for the GCP project, OAuth, and gateway-side setup that pairs with these CLI commands.

## Related

- [CLI reference](/cli)
- [Webhook automation](/automation/webhook)
- [Gmail Pub/Sub](/automation/cron-jobs#gmail-pubsub-integration)
