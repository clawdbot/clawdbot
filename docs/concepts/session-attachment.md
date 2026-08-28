---
doc-schema-version: 1
summary: "How Gateway-owned sessions continue across the Control UI, terminal, CLI, mobile clients, and coding harnesses"
read_when:
  - You want to continue a Control UI session in the terminal
  - You want to attach a coding harness to an existing session
  - You are troubleshooting session links, remote pairing, or attachment failures
title: "Session synchronization and attachment"
---

OpenClaw keeps shared session state on the Gateway. The Control UI, mobile
clients, ACP, `openclaw tui <target>`, and `openclaw attach <target>` project
that Gateway-owned state instead of keeping independent session copies. This
lets you open one session in several clients without exporting or copying its
transcript.

Use `openclaw tui` when you want to continue the conversation in a terminal.
Use `openclaw attach` when you want a coding harness beside the session with a
temporary, session-scoped MCP grant.

Embedded local mode is separate: `openclaw tui --local`, `openclaw chat`, and
`openclaw terminal` use the local agent runtime and cannot accept a session
target. See the [TUI CLI reference](/cli/tui#notes) for local-mode behavior.

## One Gateway, many clients

The Gateway owns session rows, transcript history, routing metadata, and active
runs. Clients select a session key and read or update that same state through the
Gateway protocol. A mobile node remains a peripheral connected to the Gateway;
it does not become a second session owner.

Most agent session keys use this shape:

```text
agent:<agentId>:<rest>
```

The `<rest>` portion may be a simple name, several colon-delimited routing
segments, or a value ending in a UUID. A Gateway configured with global session
scope uses the canonical `global` session instead. When an agent-only URL is
opened against a global-scope Gateway, the CLI asks the Gateway for its session
scope and resolves the URL to that canonical global session.

See [Session management](/concepts/session) for routing, isolation, lifecycle,
and storage details.

## Session URLs and short links

Control UI chat and dashboard links share this route grammar:

```text
/{chat|dashboard}/<agentId>
/{chat|dashboard}/<agentId>/<slug>-<shortId>
/{chat|dashboard}/<agentId>/<literal-rest-segments...>
```

A configured Control UI base path prefixes these routes. The agent-only form
opens that agent's main projection. Literal forms encode the colon-delimited
session key after `agent:<agentId>:` as path segments.

For a key whose rest ends in a UUID, the shareable short form uses 8 to 32
lowercase hexadecimal characters from the start of that UUID, with UUID dashes
removed. The short ID is authoritative. The display-name slug is decorative
unless two sessions share the same prefix, in which case one exact slug match
breaks the tie. For CLI short-link targets, the agent segment is also decorative:
the Gateway resolves the short ID without constraining it to that URL agent.

The Gateway method `sessions.resolve` owns resolution for exact keys, raw
session IDs, labels, and short IDs. Discovery selectors are filtered by the
calling client's session visibility. Short-ID ambiguity results contain at most
ten recent candidates, so clients can ask you for a longer prefix without
guessing. See [Control UI URLs](/web/urls) for the complete literal encoding and
stability contract.

### Gateway version requirement

The Gateway resolves short references at the session store owner, and the
Control UI and CLI use the returned canonical key. Short links require a current
Gateway. If an older or custom Gateway rejects the `shortId` selector, upgrade
it or use a full session key.

## Choose how to continue

The CLI accepts three target syntaxes:

- A complete Control UI URL, such as
  `https://claw.example.com/dashboard/main/deploy-monitor-6db92d48`.
- Gateway shorthand, such as
  `claw.example.com/main/deploy-monitor-6db92d48`.
- A bare short reference or full key, such as `deploy-monitor-6db92d48` or
  `agent:main:telegram:12345`. Bare references use the configured or default
  Gateway.

Session URLs must not contain credentials. Pass `--token` or `--password`
separately when first pairing with a Gateway origin.

### Continue in the terminal

From the Control UI, open the session header menu and choose **Continue in
terminal…**. The dialog copies a credential-free `openclaw resume` command with
one opaque, versioned handoff argument. The argument encodes only the exact
agent-qualified session key and selected Gateway WebSocket URL. The key is
bounded to 512 user-perceived characters. Its URL-safe alphabet needs no shell
quoting, so the command is safe to paste in common POSIX shells, PowerShell, and
`cmd.exe`. Run it in an OpenClaw CLI profile that is already configured for that
Gateway; the terminal authenticates independently. The Gateway canonicalizes
the key before the TUI attaches, and a missing session produces recovery
guidance instead of creating another session. The session ACL still applies.

Query-routed Gateway URLs cannot produce this credential-free command because
Gateway authentication and stored device scope are not query-aware. The Control
UI does not strip or copy the query. Use a manually authenticated CLI target
with explicit `--token` or `--password`, or configure a queryless Gateway URL.

You can also choose or query a recent session directly:

```bash
openclaw resume
openclaw resume agent:main:deploy-monitor
```

For Gateway-backed continuation from a URL or short reference, pass the target
to `openclaw tui`:

```bash
openclaw tui https://claw.example.com/dashboard/main/deploy-monitor-6db92d48
openclaw tui deploy-monitor-6db92d48
```

You can also paste a complete session URL directly at the CLI root:

```bash
openclaw https://claw.example.com/dashboard/main/deploy-monitor-6db92d48
```

This opens the TUI on the canonical session key returned by the Gateway. It does
not clone the transcript or create a new session. See [TUI](/cli/tui) for target
conflicts, supported bare-URL options, and examples.

### Attach a coding harness

Pass the same URL or reference to `openclaw attach`:

```bash
openclaw attach https://claw.example.com/dashboard/main/deploy-monitor-6db92d48
openclaw attach deploy-monitor-6db92d48
```

The Gateway resolves the session first, then mints a temporary grant scoped to
that session and launches the coding harness with a strict MCP configuration.
The bearer token travels in the child environment instead of argv. A normal
launch revokes the grant when the harness exits; `--print-config` leaves it live
until its TTL expires. See [Attach CLI](/cli/attach) for grant lifetime and
launch options.

## Pair once per Gateway origin

A URL or gateway shorthand authoritatively selects one normalized Gateway
origin. OpenClaw never reuses configured credentials or a stored device token
from another origin for that target. The credential-free command copied by
**Continue in terminal…** has a narrower rule: `openclaw resume` may reuse the
current CLI profile only when its explicit WebSocket URL byte-for-byte matches
that profile's mode: local and public-origin targets are eligible only in local
mode, while only `gateway.remote.url` is eligible in remote mode. It never
searches other profiles, and any host, port, or path mismatch returns to the
normal explicit-credential requirement. Exact direct-local targets may reuse
the local listener's certificate fingerprint, and exact configured remote
targets may reuse the configured remote pin. A public-origin target does not
inherit the local listener's pin; pass `--tls-fingerprint` explicitly if that
proxy origin needs one. The payload contains no credentials; explicit `--token`,
`--password`, or `--tls-fingerprint` values supplied beside the handoff still
take priority. Handoff resolution suppresses ambient
`OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_GATEWAY_PASSWORD` fallback while keeping
those explicit values and exact-target configured credentials eligible.

On first contact:

1. Run the TUI or attach command with `--token` or `--password` once.
2. Open **Settings > Devices** in that Gateway's Control UI and approve the
   pending request. On the Gateway host, you can instead preview the newest
   request with `openclaw devices approve --latest`, verify it, and run the
   printed `openclaw devices approve <requestId>` command.
3. Retry the original command. OpenClaw stores the issued operator device token
   in SQLite under that exact normalized Gateway origin.
4. Later connections to the same origin can use the stored device token. An
   explicit `--token` or `--password` always wins for the entire connection.

The Control UI continuation command does not perform these first-contact steps
or carry their credentials. Configure or pair the terminal independently before
using it. If the CLI rejects an invalid or truncated handoff, copy a fresh
command from the Control UI instead of editing the opaque argument. If the
session was deleted after the command was copied, return to the Control UI and
copy a command from an available session.

Revoke or remove the device from the same Gateway's **Devices** page when that
client should no longer connect. Tokens do not cross origins. Read-only probes
through an SSH tunnel also suppress stored device auth because the loopback
transport does not identify the remote origin; explicit credentials still work.

See [Devices](/cli/devices), [Remote access](/gateway/remote), and
[Gateway security](/gateway/security) for approval, rotation, revocation, and
network guidance.

## Failure taxonomy

Gateway connection failures use one structured-first classifier. Older
Gateways still work through a bounded text fallback, so health, status, and the
TUI give the same category and recovery guidance.

| Failure or kind                    | What it means                                                                            | What to do                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Older Gateway short-link rejection | The Gateway does not accept `shortId` in `sessions.resolve`.                             | Copy the full session key from that Gateway's Control UI, or upgrade the Gateway.                                                                               |
| Session missing                    | The selected Gateway cannot find that key or short ID.                                   | For the configured Gateway, run `openclaw sessions list`. For a URL target, choose the session in that Gateway's Control UI.                                    |
| Session reference ambiguous        | More than one visible session shares the prefix and the slug did not select one.         | Use one of the longer ID prefixes shown by the CLI, or copy the full key.                                                                                       |
| `pairing-required`                 | The device is new or an existing device needs a role, scope, or metadata approval.       | Approve the pending request in **Settings > Devices**, or preview it with `openclaw devices approve --latest` and run the printed exact-ID command, then retry. |
| `device-identity-required`         | The Gateway requires a signed device identity for this connection.                       | Use a current OpenClaw client, let it create its device identity, and complete pairing.                                                                         |
| `scope-mismatch`                   | The stored device token is valid but lacks the requested operator scope.                 | Review `openclaw devices list`, approve the pending scope upgrade, and reconnect.                                                                               |
| `auth-rejected`                    | An explicit shared credential is wrong, or a paired-device token was revoked or rotated. | Verify explicit Gateway auth. For a stale device token, rotate it with `openclaw devices rotate --device <deviceId> --role operator` or pair again.             |
| `rate-limited`                     | Too many failed authentication attempts caused a temporary lockout.                      | Wait for the lockout to expire, then retry. Do not rotate credentials merely because the Gateway is rate-limited.                                               |
| `gateway-rejected`                 | The Gateway returned another structured rejection, such as a protocol mismatch.          | Follow the error details. For version skew, update the older client or Gateway before retrying.                                                                 |
| `unreachable`                      | The selected origin cannot be reached.                                                   | Check the Gateway process and route. For a `*.ts.net` host, connect Tailscale and confirm tailnet reachability; for SSH, confirm the tunnel is running.         |
| TLS fingerprint mismatch           | The presented certificate does not match the configured or explicit pin.                 | Verify the certificate and expected fingerprint. Change the pin only after confirming the Gateway identity.                                                     |

## Related pages

- [Session management](/concepts/session)
- [Control UI URLs](/web/urls)
- [TUI](/cli/tui)
- [Attach CLI](/cli/attach)
- [Devices](/cli/devices)
- [Remote access](/gateway/remote)
- [Gateway security](/gateway/security)
