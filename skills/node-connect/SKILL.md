---
name: node-connect
description: Diagnose OpenClaw Android, iOS, or macOS node pairing, QR/setup code, route, auth, and connection failures.
---

# Node Connect

Goal: find the one real route from node -> gateway, verify OpenClaw is advertising that route, then fix pairing/auth.

## Topology first

Decide which case you are in before proposing fixes:

- same machine / emulator / USB tunnel
- same LAN / local Wi-Fi
- same Tailscale tailnet
- public URL / reverse proxy

Do not mix them.

- Local Wi-Fi problem: do not switch to Tailscale unless remote access is actually needed.
- VPS / remote gateway problem: do not keep debugging `localhost` or LAN IPs.

## If ambiguous, ask first

If the setup is unclear or the failure report is vague, ask short clarifying questions before diagnosing.

Ask for:

- which route they intend: same machine, same LAN, Tailscale tailnet, or public URL
- whether they used QR/setup code or manual host/port
- the exact app text/status/error, quoted exactly if possible
- whether `openclaw devices list` shows a pending pairing request

Do not guess from `can't connect`.

## Canonical checks

Prefer `openclaw qr --json`. It uses the same setup-code payload Android scans.

```bash
openclaw config get gateway.mode
openclaw config get gateway.bind
openclaw config get gateway.tailscale.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
openclaw config get gateway.auth.allowTailscale
openclaw config get plugins.entries.device-pair.config.publicUrl
openclaw qr --json
openclaw devices list
openclaw nodes status
```

If this OpenClaw instance is pointed at a remote gateway, also run:

```bash
openclaw qr --remote --json
```

If Tailscale is part of the story:

```bash
tailscale status --json
```

## Read the result, not guesses

`openclaw qr --json` success means:

- `gatewayUrl`: this is the actual endpoint the app should use.
- `urlSource`: this tells you which config path won.

Common good sources:

- `gateway.bind=lan`: same Wi-Fi / LAN only
- `gateway.bind=tailnet`: direct tailnet access
- `gateway.tailscale.mode=serve` or `gateway.tailscale.mode=funnel`: Tailscale route
- `plugins.entries.device-pair.config.publicUrl`: explicit public/reverse-proxy route
- `gateway.remote.url`: remote gateway route

## Root-cause map

If `openclaw qr --json` says `Gateway is only bound to loopback`:

- remote node cannot connect yet
- fix the route, then generate a fresh setup code
- `gateway.bind=auto` is not enough if the effective QR route is still loopback
- same LAN: use `gateway.bind=lan`
- same tailnet: prefer `gateway.tailscale.mode=serve` or use `gateway.bind=tailnet`
- public internet: set a real `plugins.entries.device-pair.config.publicUrl` or `gateway.remote.url`

If `gateway.bind=tailnet set, but no tailnet IP was found`:

- gateway host is not actually on Tailscale

If `qr --remote requires gateway.remote.url`:

- remote-mode config is incomplete

If the app says `pairing required`:

- network route and auth worked
- approve the pending device

```bash
openclaw devices list
openclaw devices approve --latest
```

If the app says `bootstrap token invalid or expired`:

- old setup code
- generate a fresh one and rescan
- do this after any URL/auth fix too

If the app says `unauthorized`:

- wrong token/password, or wrong Tailscale expectation
- for Tailscale Serve, `gateway.auth.allowTailscale` must match the intended flow
- otherwise use explicit token/password

## Fast heuristics

- Same Wi-Fi setup + gateway advertises `127.0.0.1`, `localhost`, or loopback-only config: wrong.
- Remote setup + setup/manual uses private LAN IP: wrong.
- Tailnet setup + gateway advertises LAN IP instead of MagicDNS / tailnet route: wrong.
- Public URL set but QR still advertises something else: inspect `urlSource`; config is not what you think.
- `openclaw devices list` shows pending requests: stop changing network config and approve first.

## Fix style

Reply with one concrete diagnosis and one route.

If there is not enough signal yet, ask for setup + exact app text instead of guessing.

Good:

- `The gateway is still loopback-only, so a node on another network can never reach it. Enable Tailscale Serve, restart the gateway, run openclaw qr again, rescan, then approve the pending device pairing.`

Bad:

- `Maybe LAN, maybe Tailscale, maybe port forwarding, maybe public URL.`
