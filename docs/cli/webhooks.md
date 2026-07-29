---
summary: "CLI reference for `openclaw webhooks` (Gmail Pub/Sub setup and runner)"
read_when:
  - You want to wire Gmail Pub/Sub events into OpenClaw
  - You need the full flag list and default values
title: "Webhooks"
---

# `openclaw webhooks`

Webhook helpers and integrations. Today this surface is scoped to Gmail Pub/Sub flows built on the bundled `gog` watcher.

## Subcommands

```bash
openclaw webhooks gmail setup --account <email> [...]
openclaw webhooks gmail run   [--account <email>] [...]
```

| Subcommand    | Description                                                                           |
| ------------- | ------------------------------------------------------------------------------------- |
| `gmail setup` | One-time wizard: Gmail watch, Pub/Sub topic/subscription, and OpenClaw hook delivery. |
| `gmail run`   | Run `gog watch serve` plus the watch auto-renew loop in the foreground.               |

<Note>
The Gateway also auto-starts `gog gmail watch serve` on boot once `hooks.enabled=true` and `hooks.gmail.account` is set (set by `gmail setup`). `gmail run` is the same logic in the foreground, useful for debugging or when the Gateway watcher is disabled. See [Gmail Pub/Sub integration](/automation/cron-jobs#gmail-pubsub-integration) for the auto-start details and `OPENCLAW_SKIP_GMAIL_WATCHER` opt-out.
</Note>

## `webhooks gmail setup`

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail setup --account you@example.com --project my-gcp-project --json
openclaw webhooks gmail setup --account you@example.com --hook-url https://gateway.example.com/hooks/gmail
```

Installs `gcloud` and `gog` if missing, authenticates `gcloud`, creates the Pub/Sub topic and subscription, starts the Gmail watch, and writes `hooks.gmail` config with `hooks.enabled=true`. Prints `Next: openclaw webhooks gmail run`.

### Required

| Flag                | Description             |
| ------------------- | ----------------------- |
| `--account <email>` | Gmail account to watch. |

### Pub/Sub options

| Flag                    | Default                | Description                                                                                                                             |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`        | (none)                 | GCP project id (the OAuth client owner). Falls back to the topic's own project id, then to the project resolved from `gog` credentials. |
| `--topic <name>`        | `gog-gmail-watch`      | Pub/Sub topic name.                                                                                                                     |
| `--subscription <name>` | `gog-gmail-watch-push` | Pub/Sub subscription name.                                                                                                              |
| `--label <label>`       | `INBOX`                | Gmail label to watch.                                                                                                                   |
| `--push-endpoint <url>` | (none)                 | Explicit Pub/Sub push endpoint. Overrides Tailscale.                                                                                    |

### OpenClaw delivery options

| Flag                   | Default                                      | Description                                |
| ---------------------- | -------------------------------------------- | ------------------------------------------ |
| `--hook-url <url>`     | Built from `hooks.path` and the Gateway port | OpenClaw webhook URL.                      |
| `--hook-token <token>` | `hooks.token`, or a generated token          | OpenClaw webhook token.                    |
| `--push-token <token>` | Generated token                              | Push token forwarded to `gog watch serve`. |

### `gog watch serve` options

| Flag                  | Default         | Description                                                                                                                                  |
| --------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bind <host>`       | `127.0.0.1`     | `gog watch serve` bind host.                                                                                                                 |
| `--port <port>`       | `8788`          | `gog watch serve` port.                                                                                                                      |
| `--path <path>`       | `/gmail-pubsub` | `gog watch serve` path. Forced to `/` when Tailscale is enabled without an explicit target, since Tailscale strips the path before proxying. |
| `--include-body`      | `true`          | Include email body snippets. There is no CLI flag to turn this off; set `hooks.gmail.includeBody: false` in config instead.                  |
| `--max-bytes <n>`     | `20000`         | Max bytes per body snippet.                                                                                                                  |
| `--renew-minutes <n>` | `720` (12h)     | Renew Gmail watch every N minutes.                                                                                                           |

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

```bash
openclaw webhooks gmail run --account you@example.com
```

Runs `gog watch serve` plus the watch auto-renew loop in the foreground, restarting `gog watch serve` after a 2s delay if it exits unexpectedly.

`run` accepts the same Pub/Sub, OpenClaw delivery, `gog watch serve`, and Tailscale flags as `setup`, except:

- `--account` is **optional** on `run`; it falls back to `hooks.gmail.account`.
- `run` does **not** accept `--project`, `--push-endpoint`, or `--json`.
- Every flag falls back to the matching `hooks.gmail.*` config value (written by `setup`), then to the same built-in default `setup` uses, with one exception: `--tailscale` defaults to `off` on `run` (not `funnel`) when neither the flag nor `hooks.gmail.tailscale.mode` is set.

| Category          | Flags                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Pub/Sub           | `--account`, `--topic`, `--subscription`, `--label`                              |
| OpenClaw delivery | `--hook-url`, `--hook-token`, `--push-token`                                     |
| `gog watch serve` | `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes` |
| Tailscale         | `--tailscale`, `--tailscale-path`, `--tailscale-target`                          |

<Note>
For `run`, the `--topic` value is the full Pub/Sub topic path (`projects/.../topics/...`), not just the short topic name.
</Note>

## Related

- [CLI reference](/cli)
- [Webhook automation](/automation/webhook)
- [Gmail Pub/Sub integration](/automation/cron-jobs#gmail-pubsub-integration)
