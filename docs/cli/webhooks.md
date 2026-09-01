---
doc-schema-version: 1
summary: "CLI reference for `openclaw webhooks` (Gmail Pub/Sub setup and runner)"
read_when:
  - You want to wire Gmail Pub/Sub events into OpenClaw
  - You need the full flag list and default values
title: "Webhooks"
---

# `openclaw webhooks`

`openclaw webhooks` sets up and runs the Gmail Pub/Sub transport through `gog` (gogcli). It does not register [internal `HOOK.md` hooks](/automation/hooks), manage arbitrary [Gateway hook mappings](/automation/cron-jobs#webhooks), or manage the [TaskFlow Webhooks plugin](/plugins/webhooks).

## Subcommands

```bash
openclaw webhooks gmail setup --account <email> [...]
openclaw webhooks gmail run   [--account <email>] [...]
```

| Subcommand    | Description                                                                           |
| ------------- | ------------------------------------------------------------------------------------- |
| `gmail setup` | One-time wizard: Gmail watch, Pub/Sub topic/subscription, and OpenClaw hook delivery. |
| `gmail run`   | Run `gog gmail watch serve` plus the watch auto-renew loop in the foreground.         |

<Note>
The Gateway also auto-starts `gog gmail watch serve` on boot once `hooks.enabled=true` and `hooks.gmail.account` is set (set by `gmail setup`). `gmail run` provides a foreground watcher for debugging or when the Gateway watcher is disabled. Do not run both against the same listener. See [Gmail Pub/Sub integration](/automation/cron-jobs#gmail-pubsub-integration) for the auto-start details and `OPENCLAW_SKIP_GMAIL_WATCHER` opt-out.
</Note>

## `webhooks gmail setup`

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail setup --account you@example.com --project my-gcp-project --json
openclaw webhooks gmail setup --account you@example.com --hook-url https://gateway.example.com/hooks/gmail
```

Authenticates `gcloud`, enables the required APIs, creates or updates the Pub/Sub topic/subscription and push endpoint, starts the Gmail watch, and writes `hooks.gmail` with `hooks.enabled: true` and the Gmail preset. Missing `gcloud`, `gog`, and Tailscale dependencies can be installed automatically on macOS with Homebrew; other platforms need them installed first. The Gmail account must already be authorized in `gog`.

Setup changes cloud resources, exposure settings, and local config; it is not a read-only check. Re-running it can apply the CLI defaults over saved Gmail settings. It prints `Next: openclaw webhooks gmail run`; use that only if the Gateway-managed watcher is not already running.

<Warning>
This command connects Gmail transport but does not create a restricted reader agent or the session-key policy required by the templated preset. Without a custom Gmail mapping that sets `agentId`, inbound email runs as the default agent with that agent's effective workspace, sandbox, and tool policy. Complete [Configure a restricted Gmail reader](/automation/cron-jobs#configure-a-restricted-gmail-reader-recommended) before running setup for an untrusted inbox.
</Warning>

### Required

| Flag                | Description             |
| ------------------- | ----------------------- |
| `--account <email>` | Gmail account to watch. |

### Pub/Sub options

| Flag                    | Default                | Description                                                                                                                                                                            |
| ----------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <id>`        | (none)                 | GCP project id (the OAuth client owner). Falls back to the topic's own project id, then to the project resolved from `gog` credentials.                                                |
| `--topic <name>`        | `gog-gmail-watch`      | Pub/Sub topic name.                                                                                                                                                                    |
| `--subscription <name>` | `gog-gmail-watch-push` | Pub/Sub subscription name.                                                                                                                                                             |
| `--label <label>`       | `INBOX`                | Gmail label to watch.                                                                                                                                                                  |
| `--push-endpoint <url>` | (none)                 | Explicit Pub/Sub push endpoint. Skips Tailscale endpoint setup; use `--tailscale off` for externally managed exposure. The URL is used as supplied, including any required push token. |

### OpenClaw delivery options

| Flag                   | Default                                       | Description                                                                      |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `--hook-url <url>`     | `hooks.gmail.hookUrl`, then local Gateway URL | OpenClaw webhook URL; generated fallback uses `hooks.path` and the Gateway port. |
| `--hook-token <token>` | `hooks.token`, or a generated token           | OpenClaw webhook token.                                                          |
| `--push-token <token>` | `hooks.gmail.pushToken`, or a generated token | Separate token authenticating Pub/Sub to `gog gmail watch serve`.                |

<a id="gog-watch-serve-options" />

### `gog gmail watch serve` options

| Flag                  | Default         | Description                                                                                                                                        |
| --------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bind <host>`       | `127.0.0.1`     | `gog gmail watch serve` bind host.                                                                                                                 |
| `--port <port>`       | `8788`          | `gog gmail watch serve` port.                                                                                                                      |
| `--path <path>`       | `/gmail-pubsub` | `gog gmail watch serve` path. Forced to `/` when Tailscale is enabled without an explicit target, since Tailscale strips the path before proxying. |
| `--include-body`      | `true`          | Include email body snippets. There is no CLI flag to turn this off; set `hooks.gmail.includeBody: false` in config instead.                        |
| `--max-bytes <n>`     | `20000`         | Max bytes per body snippet.                                                                                                                        |
| `--renew-minutes <n>` | `720` (12h)     | Renew Gmail watch every N minutes.                                                                                                                 |

### Tailscale exposure

| Flag                          | Default                                            | Description                                                      |
| ----------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `--tailscale <mode>`          | `funnel`                                           | Expose push endpoint via tailscale: `funnel`, `serve`, or `off`. |
| `--tailscale-path <path>`     | `hooks.gmail.tailscale.path`, then serve path      | Path for tailscale serve/funnel.                                 |
| `--tailscale-target <target>` | `hooks.gmail.tailscale.target`, then local watcher | Tailscale serve/funnel target (port, `host:port`, or URL).       |

### Output

| Flag     | Description                                       |
| -------- | ------------------------------------------------- |
| `--json` | Print a machine-readable summary instead of text. |

<Warning>Setup output is sensitive: `--json` includes `hookToken` and `pushToken`, and the push endpoint printed in either format can contain its token. Redact output before sharing it.</Warning>

Command failures show bounded tails from both stdout and stderr, with terminal colors and progress redraws removed. Exit codes and recorded termination reasons distinguish timeouts, signals, and output limits; exit code `124` alone does not mean a timeout. An omission marker (`…`) indicates truncated output. These diagnostics can still contain sensitive command output: redact them before sharing.

`--port`, `--max-bytes`, and `--renew-minutes` require positive integers, without unit suffixes. `--include-body` has no negative CLI flag: set `hooks.gmail.includeBody: false` and let `run` inherit it.

## `webhooks gmail run`

```bash
openclaw webhooks gmail run --account you@example.com
```

Starts the Gmail watch and runs `gog gmail watch serve` plus periodic watch renewal in the foreground. Unexpected serve-process exits continue to restart after 5 seconds. A bind conflict stops restarts; run only one watcher per listener and stop the other watcher before retrying. Ctrl-C or SIGTERM cancels pending restarts and renewal work and shuts down the serve process tree. Investigate repeated exits in the logs.

`run` accepts the same Pub/Sub, OpenClaw delivery, `gog gmail watch serve`, and Tailscale flags as `setup`, except:

- `--account` is **optional** on `run`; it falls back to `hooks.gmail.account`.
- `run` does **not** accept `--project`, `--push-endpoint`, or `--json`.
- Unspecified flags inherit the matching `hooks.gmail.*` setting; `--hook-token` inherits `hooks.token`.
- Account, full topic path, hook token, and push token must be supplied or configured. `run` does not generate missing tokens, provision Pub/Sub resources, or rewrite config.
- Other fields use the setup defaults when no saved setting exists, except `--tailscale`, which defaults to `off` rather than `funnel`.

| Category                | Flags                                                                            |
| ----------------------- | -------------------------------------------------------------------------------- |
| Pub/Sub                 | `--account`, `--topic`, `--subscription`, `--label`                              |
| OpenClaw delivery       | `--hook-url`, `--hook-token`, `--push-token`                                     |
| `gog gmail watch serve` | `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes` |
| Tailscale               | `--tailscale`, `--tailscale-path`, `--tailscale-target`                          |

<Note>
For `run`, the `--topic` value is the full Pub/Sub topic path (`projects/.../topics/...`), not just the short topic name.
</Note>

## Verify forwarding

```bash
openclaw config validate
openclaw logs --follow
```

Send a test from another account to the watched inbox. The watcher excludes
`SPAM`, `TRASH`, `DRAFT`, and `SENT` messages. Check watcher forwarding errors,
then the Gateway hook completion/error logs and the reader's run output.
A successful push or HTTP admission response does not prove email processing or
channel delivery completed. Follow the [reader boundary
check](/automation/cron-jobs#verify-the-reader-boundary) before connecting an
untrusted inbox.

## Related

- [CLI reference](/cli)
- [Webhook automation](/automation/cron-jobs#webhooks)
- [Gmail Pub/Sub integration](/automation/cron-jobs#gmail-pubsub-integration)
