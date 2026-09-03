---
summary: "CLI reference for `openclaw qr` (generate mobile pairing QR + setup code)"
read_when:
  - You want to pair a mobile node app with a gateway quickly
  - You need setup-code output for remote/manual sharing
title: "QR"
---

# `openclaw qr`

Generate a mobile pairing QR and setup code from your current Gateway configuration.

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --limited
openclaw qr --voice-node
openclaw qr --url wss://gateway.example/ws
```

Official OpenClaw iOS and Android apps connect automatically when their
setup-code metadata matches. If a request remains pending (for example, for a
non-official client or mismatched metadata), review and approve it:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

## Options

- `--remote`: prefer `gateway.remote.url`; falls back to `gateway.tailscale.mode=serve|funnel` if that URL is unset. Ignores `device-pair` plugin `publicUrl`.
- `--url <url>`: override the gateway URL used in the payload
- `--public-url <url>`: override the public URL used in the payload
- `--token <token>`: override the gateway token the bootstrap flow authenticates against
- `--password <password>`: override the gateway password the bootstrap flow authenticates against
- `--limited`: omit administrative Gateway access from the handed-off operator token
- `--voice-node`: issue node credentials plus only `operator.read` and `operator.talk`
- `--setup-code-only`: print only the setup code
- `--no-ascii`: skip ASCII QR rendering
- `--json`: emit JSON (`setupCode`, `gatewayUrl`, optional `gatewayUrls`, `auth`, `access`, optional `accessDowngraded`, `urlSource`)

`--token` and `--password` are mutually exclusive. `--limited` and `--voice-node` are mutually exclusive.

## Setup code contents

The setup code carries an opaque, short-lived `bootstrapToken`, not the shared gateway token/password. For a `wss://` endpoint (or same-host loopback), the default bootstrap flow issues:

- a primary `node` token with `scopes: []`
- a full native-mobile `operator` handoff token with `operator.admin`, `operator.approvals`, `operator.read`, `operator.talk.secrets`, and `operator.write`

Use `--limited` to keep the same node token while omitting `operator.admin` from the operator handoff. Pairing-mutation scope is never handed off by a setup code.

Use `--voice-node` for an embedded or room voice client. It keeps the node token and hands off a separate operator token limited to `operator.read` and `operator.talk`; it cannot send messages, mutate configuration, or invoke general write-scoped Gateway methods.

Plaintext LAN `ws://` setup remains available, but OpenClaw automatically uses
the limited profile because a network observer could capture and race the bearer
bootstrap token. Configure `wss://` or Tailscale Serve, then generate a new code
to get full access.

## Gateway URL resolution

Mobile pairing fails closed for Tailscale/public `ws://` gateway URLs: use Tailscale Serve/Funnel or a `wss://` gateway URL for those. Private LAN addresses and `.local` Bonjour hosts remain supported over plain `ws://`, with limited operator access as described above.

The QR command advertises Tailscale URLs only when OpenClaw owns the route through `gateway.tailscale.mode=serve|funnel`. Legacy external Serve routes that target the ordinary Gateway listener are not advertised because that listener rejects Tailscale-shaped proxy ingress.

If an older setup used `gateway.bind=lan` with a persistent default HTTPS Serve
route, run `openclaw doctor` to inspect it. Doctor does not migrate or clear the
route because its status cannot prove who owns it, even with `--fix`; if you
confirm it is stale, clear only its root handler, configure
`gateway.bind=loopback` plus `gateway.tailscale.mode=serve` manually, and restart
the Gateway. Custom Serve ports and retired named-Service routes require the
same manual cleanup; Doctor prints the relevant guidance.

With `--remote`, one of `gateway.remote.url` or `gateway.tailscale.mode=serve|funnel` is required.

## Auth resolution (no `--remote`)

When no CLI auth override is passed, local gateway auth SecretRefs resolve as follows:

| Condition                                                                                                                    | Resolves                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `gateway.auth.mode="token"`, or inferred mode with no winning password source                                                | `gateway.auth.token`                      |
| `gateway.auth.mode="password"`, or inferred mode with no winning token from auth/env                                         | `gateway.auth.password`                   |
| Both `gateway.auth.token` and `gateway.auth.password` are configured (including SecretRefs) and `gateway.auth.mode` is unset | fails; set `gateway.auth.mode` explicitly |

## Auth resolution (`--remote`)

If effectively active remote credentials are configured as SecretRefs and neither `--token` nor `--password` is passed, the command resolves them from the active gateway snapshot. If the gateway is unavailable, the command fails fast.

<Note>
This command path requires a gateway that supports the `secrets.resolve` RPC method. Older gateways return an unknown-method error.
</Note>

## Related

- [CLI reference](/cli)
- [Devices](/cli/devices)
- [Pairing](/cli/pairing)
