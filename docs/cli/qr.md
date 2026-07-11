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
- `--setup-code-only`: print only the setup code
- `--no-ascii`: skip ASCII QR rendering
- `--json`: emit JSON (`setupCode`, `gatewayUrl`, optional `gatewayUrls`, `auth`, `urlSource`)

`--token` and `--password` are mutually exclusive.

## Setup code contents

The setup code carries an opaque, short-lived `bootstrapToken`, not the shared gateway token/password. The built-in bootstrap flow issues:

- a primary `node` token with `scopes: []`
- a bounded `operator` handoff token limited to `operator.approvals`, `operator.read`, `operator.talk.secrets`, and `operator.write`

Pairing-mutation scopes and `operator.admin` still require a separate approved operator pairing or token flow.

## Gateway URL resolution

Mobile pairing fails closed for Tailscale/public `ws://` gateway URLs: use Tailscale Serve/Funnel or a `wss://` gateway URL for those. Private LAN addresses and `.local` Bonjour hosts remain supported over plain `ws://`.

When the selected Gateway URL comes from `gateway.bind=lan`, OpenClaw also checks persistent `tailscale serve status --json` routes. Any HTTPS Serve root that proxies the active Gateway's loopback port is included as a fallback. The QR command adds this fallback only for `lan`; `custom` and `tailnet` keep their explicitly advertised routes. Current iOS clients probe the advertised routes in order and save the first reachable one; the legacy `url` field remains unchanged for older clients.

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
