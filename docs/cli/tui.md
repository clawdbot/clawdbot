---
summary: "CLI reference for `openclaw tui` (Gateway-backed or local embedded terminal UI)"
read_when:
  - You want a terminal UI for the Gateway (remote-friendly)
  - You want to pass url/token/session from scripts
  - You want to run the TUI in local embedded mode without a Gateway
  - You want to use openclaw chat or openclaw tui --local
title: "openclaw tui"
---

# `openclaw tui`

Open the terminal UI connected to the Gateway, or run it in local embedded
mode.

```bash
openclaw tui [target]
```

`target` can be a Control UI session URL, a compact `host/agent/ref`, a bare
short reference such as `movies-a1166b81`, or a literal `agent:...` session key.
A URL or host target authoritatively selects that Gateway; a bare reference
uses the configured or default Gateway. You can also paste a Control UI URL
directly as `openclaw <url>` and place the TUI options before or after it, for example
`openclaw <url> --token <token> --deliver`.

The bare-URL form accepts `--token`, `--password`, `--tls-fingerprint`,
`--deliver`, `--thinking`, `--message`, `--timeout-ms`, and `--history-limit`.
URL-valued messages work in either position, including
`openclaw --message https://example.com/article <url>`.
Use `openclaw tui <url>` when you need another TUI option; `--local`, `--url`,
and `--session` conflict with a session URL.

Related guide: [TUI](/web/tui)

## Options

| Flag                         | Default                                   | Description                                                                        |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `--local`                    | `false`                                   | Run against the local embedded agent runtime instead of a Gateway.                 |
| `--url <url>`                | `gateway.remote.url` from config          | Gateway WebSocket URL.                                                             |
| `--token <token>`            | (none)                                    | Gateway token if required.                                                         |
| `--password <pass>`          | (none)                                    | Gateway password if required.                                                      |
| `--tls-fingerprint <sha256>` | `gateway.remote.tlsFingerprint`           | Expected TLS certificate fingerprint for a pinned `wss://` Gateway.                |
| `--session <key>`            | `main` (or `global` when scope is global) | Session key. Inside an agent workspace it auto-selects that agent unless prefixed. |
| `--deliver`                  | `false`                                   | Deliver assistant replies through configured channels.                             |
| `--thinking <level>`         | (model default)                           | Thinking level override.                                                           |
| `--message <text>`           | (none)                                    | Send an initial message after connecting.                                          |
| `--timeout-ms <ms>`          | `agents.defaults.timeoutSeconds`          | Agent timeout. Invalid values log a warning and are ignored.                       |
| `--history-limit <n>`        | `200`                                     | History entries to load on attach.                                                 |

Aliases: `openclaw chat` and `openclaw terminal` invoke this command with
`--local` implied.

## Notes

- `--local` cannot combine with `--url`, `--token`, `--password`, or `--tls-fingerprint`.
- Pass only one Gateway target. A URL target cannot combine with `--url`, and
  any positional target cannot combine with `--session` or local mode.
- A URL or host target never reuses configured credentials or
  `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`. It uses the stored
  device token for that exact Gateway origin, or explicit `--token`/`--password`
  credentials. On first contact, pass one of those credentials once, approve
  the pairing request in that Gateway's Control UI, and retry; see
  [Devices](/cli/devices).
- Session URLs must stay credential-free. Userinfo and sensitive query or
  fragment parameters such as `token` and `password` are rejected.
- Short references resolve through the Gateway. If a short reference is
  ambiguous, the CLI prints candidate names and longer ID prefixes without
  attaching to either session.
- With no URL/host target or explicit `--url`, `tui` resolves configured Gateway
  auth SecretRefs for token/password auth when possible (`env`/`file`/`exec`/`store`
  providers).
- When the configured remote Gateway is behind an identity-aware proxy, `tui`
  resolves `gateway.remote.edgeAuth` SecretInputs and sends those headers only
  to that configured Gateway scope. URL or host targets for other origins never
  inherit them.
- With no explicit URL or port, `tui` follows the active local Gateway port
  recorded by the running Gateway. Explicit `--url`, `OPENCLAW_GATEWAY_URL`,
  `OPENCLAW_GATEWAY_PORT`, and remote Gateway config keep precedence.
- Launched from inside a configured agent workspace directory, TUI auto-selects
  that agent for the session key default (unless `--session` is explicitly
  `agent:<id>:...`).
- Local mode uses the embedded agent runtime directly. Most local tools work,
  but Gateway-only features are unavailable.
- Local mode requires exclusive ownership of the configured state directory. It
  refuses to start while a Gateway or another embedded writer owns that state;
  run without `--local` to use the active Gateway, or stop it first with
  `openclaw gateway stop`.
- Local mode adds `/auth [provider]` to the TUI command surface.
- Plugin approval gates still apply in local mode: tools that require approval
  prompt for a decision in the terminal, nothing is silently auto-approved.
- Session [goals](/tools/goal) appear in the footer and can be managed with
  `/goal`.

## Session target errors

| Failure                                    | Recovery                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Gateway predates short-link resolution | Copy the full session key from that Gateway's Control UI.                                                                                        |
| Session missing or short ref ambiguous     | For the configured/local Gateway, run `openclaw sessions list`; for a URL/host target, choose a longer or full key in that Gateway's Control UI. |
| Gateway unreachable                        | The error names the selected origin. For a `*.ts.net` host, connect Tailscale and confirm the Gateway is reachable on the tailnet.               |
| Identity-aware proxy rejected the upgrade  | Configure `gateway.remote.edgeAuth` for the configured remote Gateway; the error includes the relevant remote-access docs link.                  |
| Stored device token revoked or rotated     | Rotate it with `openclaw devices rotate --device <deviceId> --role operator`, then reconnect.                                                    |
| TLS certificate pin mismatch               | The original TLS fingerprint error passes through unchanged; verify the configured or explicit pin before retrying.                              |

## Examples

```bash
openclaw chat
openclaw tui --local
openclaw tui
openclaw tui https://gateway.example/dashboard/main/movies-a1166b81
openclaw https://gateway.example/dashboard/main/movies-a1166b81 --token <token>
openclaw tui movies-a1166b81
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
openclaw chat --message "Compare my config to the docs and tell me what to fix"
# when run inside an agent workspace, infers that agent automatically
openclaw tui --session bugfix
```

## Config repair loop

Use local mode to have the embedded agent inspect the current config, compare
it against the docs, and help repair it from the same terminal.

If `openclaw config validate` is already failing, run `openclaw configure` or
`openclaw doctor --fix` first; `openclaw chat` does not bypass the
invalid-config guard.

```bash
openclaw chat
```

Then inside the TUI:

```text
!openclaw config file
!openclaw docs gateway auth token secretref
!openclaw config validate
!openclaw doctor
```

Apply targeted fixes with `openclaw config set` or `openclaw configure`, then
rerun `openclaw config validate`. See [TUI](/web/tui) and
[Config](/cli/config).

## Related

- [CLI reference](/cli)
- [TUI](/web/tui)
- [Control UI URLs](/web/urls)
- [Devices](/cli/devices)
- [Goal](/tools/goal)
