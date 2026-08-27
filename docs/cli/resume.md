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
openclaw resume --handoff <payload>
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
| `--handoff <payload>`        | (none)                           | Opaque session key and Gateway URL copied from the Control UI.      |
| `--url <url>`                | `gateway.remote.url` from config | Gateway WebSocket URL.                                              |
| `--token <token>`            | (none)                           | Gateway token if required.                                          |
| `--password <pass>`          | (none)                           | Gateway password if required.                                       |
| `--tls-fingerprint <sha256>` | `gateway.remote.tlsFingerprint`  | Expected TLS certificate fingerprint for a pinned `wss://` Gateway. |

`--handoff` cannot be combined with a positional query or `--url` because it
authoritatively supplies both. You can combine it with `--token`, `--password`,
and `--tls-fingerprint`; those explicit authentication values keep their normal
highest priority.

`resume` never starts a Gateway automatically. If the configured Gateway is
unavailable, start or repair it and rerun the command.

`resume` resolves configured Gateway auth SecretRefs for token/password auth
when possible (`env`/`file`/`exec`/`store` providers).

When present, `--handoff` supplies the target Gateway URL. Otherwise, Gateway
target precedence is explicit `--url`, then `OPENCLAW_GATEWAY_URL`, then
`gateway.remote.url` when `gateway.mode` is `remote`, then the local loopback
Gateway. For that local Gateway, `OPENCLAW_GATEWAY_PORT` takes precedence over
the active port recorded by a running Gateway, which takes precedence over the
configured or default `gateway.port`.

An explicit target normally requires an explicit `--token` or `--password`;
OpenClaw does not borrow credentials or a TLS pin from a different configured
target. `resume` has one narrow exception for a handoff copied from the Control
UI: when its Gateway URL byte-for-byte matches a canonical target of the current
profile, it may reuse that profile's configured interactive auth, SecretRef,
and stored exact-origin device auth. In local mode, the eligible targets are the
current local target with `gateway.controlUi.basePath` and `gateway.publicOrigin`
converted to WebSocket form with that base path. In remote mode, only the exact
`gateway.remote.url` is eligible. TLS pin ownership is narrower: an exact
direct-local target may reuse the
local Gateway certificate fingerprint, and an exact configured remote target
may reuse `gateway.remote.tlsFingerprint`; a public-origin target never inherits
the local listener's pin. Pass `--tls-fingerprint` explicitly when that public
origin needs a pin. A host, port, path, profile, query, or fragment mismatch
fails closed under the normal explicit-target policy. OpenClaw never scans
other profiles for a match. Handoff connections also ignore ambient
`OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_GATEWAY_PASSWORD` fallback, so shell
credentials for another Gateway cannot cross into the selected target. Explicit
flags and credentials owned by an exact configured target remain eligible.

## Continue from the Control UI

Open the selected session's header menu and choose **Continue in terminal…**.
The dialog shows one copyable `openclaw resume --handoff <payload>` command.
The opaque payload is versioned, bounded, and encoded with an unpadded URL-safe
base64 alphabet, so the command needs no quoting and is safe to paste in common
POSIX shells, PowerShell, and `cmd.exe`. The encoded argument is limited to 4096
characters; inside it, the agent-qualified session key is limited to 512
user-perceived characters and the Gateway URL to 2048 characters. It contains
only the exact qualified session key and selected Gateway WebSocket URL,
including any Control UI base path. It contains no token, password, device
credential, or bootstrap credential, and the browser does not execute it.

The Control UI does not offer this command when the selected Gateway URL uses a
query string. Gateway authentication and stored device scope are origin-based,
not query-aware, so OpenClaw never strips or copies that query into a
credential-free handoff. Use a manually authenticated CLI target with explicit
`--token` or `--password`, or configure a queryless Gateway URL.

Run the command in an already configured OpenClaw terminal. The terminal
authenticates independently. Before opening the TUI, `resume` asks that Gateway
to resolve the qualified key and uses the returned canonical key. A deleted or
stale session stops with guidance to copy a fresh command; it never starts a new
session. The Gateway's session access controls remain authoritative. This flow
continues an existing session; it does not delegate first-use authentication
from the browser.

If OpenClaw reports an invalid `--handoff` payload, return to the session's
Control UI menu and copy a fresh command. Do not edit or reuse a truncated
payload.

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

# Opaque command copied from the Control UI
openclaw resume --handoff <payload>
```

## Related

- [TUI](/cli/tui)
- [Sessions](/cli/sessions)
- [TUI guide](/web/tui)
