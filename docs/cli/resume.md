---
summary: "CLI reference for attaching the TUI to a recent Gateway session"
read_when:
  - You want to continue an existing Gateway session in the terminal
  - You want to find a recent session by key, display name, or label
  - You connect the TUI to a remote Gateway
title: "Resume"
---

# `openclaw resume`

Attach the terminal UI to an existing Gateway session. The session stays on
the Gateway; `resume` selects it and opens the existing [TUI](/cli/tui).

```bash
openclaw resume
openclaw resume <query>
```

With no query, OpenClaw displays up to 50 sessions active in the last seven
days. With a query, an exact session key wins; otherwise OpenClaw requires a
unique substring or fuzzy match across session keys, display names, and labels.

The picker omits bare `global` rows because they do not identify an owning
agent. To attach one, pass a fully qualified key such as
`openclaw resume agent:main:global`.

If a query is ambiguous, OpenClaw prints the matching candidates and exits with
status 1. If no recent session matches, it suggests the picker and
[`openclaw sessions`](/cli/sessions), then exits with status 1.

## Options

| Flag                         | Default                          | Description                                                         |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `--url <url>`                | `gateway.remote.url` from config | Gateway WebSocket URL.                                              |
| `--token <token>`            | (none)                           | Gateway token if required.                                          |
| `--password <pass>`          | (none)                           | Gateway password if required.                                       |
| `--tls-fingerprint <sha256>` | `gateway.remote.tlsFingerprint`  | Expected TLS certificate fingerprint for a pinned `wss://` Gateway. |

`resume` never starts a Gateway automatically. If the configured Gateway is
unavailable, start or repair it and rerun the command.

`resume` resolves configured Gateway auth SecretRefs for token/password auth
when possible (`env`/`file`/`exec`/`store` providers).

Gateway target precedence is explicit `--url`, then `OPENCLAW_GATEWAY_URL`,
then `gateway.remote.url` when `gateway.mode` is `remote`, then the local
loopback Gateway. For that local Gateway, `OPENCLAW_GATEWAY_PORT` takes
precedence over the active port recorded by a running Gateway, which takes
precedence over the configured or default `gateway.port`.

An explicit `--url` normally requires an explicit `--token` or `--password`;
OpenClaw does not borrow credentials or a TLS pin from a different configured
target. `resume` has one narrow exception for commands copied from the Control
UI: when `--url` byte-for-byte matches a canonical target of the current
profile, it may reuse that profile's configured interactive auth, SecretRef,
stored exact-origin device auth, and TLS pin. The eligible targets are the
current local target with `gateway.controlUi.basePath`, `gateway.remote.url` in
remote mode, and `gateway.publicOrigin` converted to WebSocket form with the
Control UI base path. A host, port, path, profile, query, or fragment mismatch
fails closed under the normal explicit-URL policy. OpenClaw never scans other
profiles for a match.

## Continue from the Control UI

Open the selected session's header menu and choose **Continue in terminal…**.
The dialog shows one copyable command containing the exact qualified session
key and selected Gateway WebSocket URL, including any Control UI base path.
The command contains no token, password, device credential, or bootstrap
credential, and the browser does not execute it.

Run the command in an already configured OpenClaw terminal. The terminal
authenticates independently, and the Gateway's session access controls remain
authoritative. This flow continues an existing session; it does not delegate
first-use authentication from the browser.

## Examples

```bash
# Choose from recent sessions
openclaw resume

# Exact key
openclaw resume agent:main:bugfix

# Unique display-name or label fragment
openclaw resume bugfix

# Remote Gateway override
openclaw resume bugfix --url wss://gateway.example.com --token <token>
```

## Related

- [TUI](/cli/tui)
- [Sessions](/cli/sessions)
- [TUI guide](/web/tui)
