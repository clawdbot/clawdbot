---
summary: "macOS IPC architecture for OpenClaw app, gateway node transport, and PeekabooBridge"
read_when:
  - Editing IPC contracts or menu bar app IPC
title: "macOS IPC"
---

# OpenClaw macOS IPC architecture

A local Unix socket connects the node host service to the macOS app for exec approvals and `system.run`. The bundled `openclaw-mac` CLI uses a separate local control socket to inspect and configure primary and saved Gateway connections. Agent actions still flow through the Gateway WebSocket and `node.invoke`. The node-backed `computer.act` path runs embedded Peekaboo automation in-process; standalone Peekaboo clients use PeekabooBridge.

## Goals

- Single GUI app instance that owns all TCC-facing work (notifications, screen recording, mic, speech, AppleScript).
- A small surface for automation: Gateway + node commands, in-process `computer.act`, plus PeekabooBridge for standalone UI automation clients.
- Predictable permissions: always the same signed bundle ID, launched by launchd, so TCC grants stick.

## How it works

### Gateway + node transport

- The app runs the Gateway (local mode) and connects to it as a node.
- Agent actions are performed via `node.invoke` (e.g. `system.run`, `system.notify`, `canvas.present`).
- Node commands include `canvas.present`, `canvas.hide`, `canvas.navigate`, `camera.list`, `camera.snap`, `camera.clip`, `camera.ptz.status`, `camera.ptz.control`, `screen.snapshot`, `screen.record`, `computer.act`, `system.run`, and `system.notify`.
- The node reports a `permissions` map so agents can see whether screen, camera, microphone, speech, automation, or accessibility access is available.

### Node service + app IPC

- A headless node host service connects to the Gateway WebSocket.
- `system.run` requests are forwarded to the macOS app over a local Unix socket (`ExecApprovalsSocket.swift`).
- The app performs the exec in UI context, prompts if needed, and returns output.
- The socket owns the request lifetime. Node cancellation or a socket deadline closes the response reader, cancelling the native prompt or command and its process group. Stopping the app's exec server also cancels and drains active requests before releasing its socket lease.
- Clients still half-close their **write** side after sending one JSONL request. That normal request EOF does not cancel execution; the response reader remains open until the result arrives.

Diagram (SCI):

```text
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### App control socket

`openclaw-mac` sends one JSONL request and receives one JSONL response per
Unix-domain connection. The running app starts and stops this listener with
its exec-approvals lifecycle owner. The shared listener owns the socket path
lease, guarded filesystem cleanup, connection framing, and shutdown drainage.
It exposes only these operations:

| Operation           | Result and effect                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `status`            | Primary connection, saved Gateways, and app version/build/profile.                                                                  |
| `primary.set`       | Set local mode, SSH transport, or direct transport through the app's native connection owners; return the resulting primary status. |
| `primary.clear`     | Return the primary connection to its unconfigured state; return primary status.                                                     |
| `gateway.list`      | List saved Gateways and their connection status.                                                                                    |
| `gateway.add`       | Validate and connect through the Gateways tab's sign-in coordinator; return the saved Gateway and identity when present.            |
| `gateway.remove`    | Resolve an ID/name and use the profile store's Remove path, including credential and dashboard-data cleanup.                        |
| `gateway.reconnect` | Repeat browser sign-in for browser profiles or reconnect the saved token/password connection.                                       |

Requests identify the operation with an `operation` string. Primary SSH
settings include `sshTarget`, optional ports, `identityPath`, and
`hostKeyPolicy` (`strict` or `openssh`); direct settings include `url` and an
optional `tlsFingerprint`. Credential-bearing operations accept `token` or
`password` inside the authenticated request; the CLI reads these from files
or stdin. Saved-Gateway requests use `name`, `url`, and `browser`, or
`idOrName` for removal/reconnection. Matching tries an exact ID first, then a
unique case-insensitive name. Ambiguity is an error with candidate names/IDs.

The default profile uses `~/.openclaw/mac-control.sock` and
`~/.openclaw/mac-control.token`. Named profiles use the corresponding
`~/.openclaw-<name>/` directory. These paths follow
`AppProfile.stateDirectoryURL`, independently of config/state environment
overrides. The app owns token creation. The token must be a regular,
user-owned file with mode `0600`; missing or unsafe credentials reject
requests. Clients must have the app's peer UID (`getpeereid`). The JSON
envelope carries a nonce, millisecond timestamp, encoded request, and
HMAC-SHA256 over the nonce, timestamp, and exact request bytes. Requests have a
15-second authentication TTL; a successfully authenticated browser sign-in
may remain open for the coordinator's bounded 300-second operation.

Socket responses use `{ok:true,result:...}` or
`{ok:false,error:{code,message}}`. The CLI's `--json` success output unwraps
`result`. `status` contains:

- `primary`: mode, nullable transport, URL, optional SSH target/remote port,
  tunnel state/local port, and connection state/version/error.
- `gateways`: ID, name, URL, authentication kind (`token`, `password`, or
  `browser`), optional Cloudflare Access identity subject/expiry, and
  connection state/error.
- `app`: version, build, and profile.

Responses never include tokens, passwords, browser-session credentials, or
Keychain contents. Saved-Gateway mutations execute inside the signed app,
where the profile store owns Keychain access, connection retirement,
dashboard cookies, and device-token cleanup. The CLI never writes the
saved-Gateway registry.

See [remote control](/platforms/mac/remote#macos-app-setup) for shell examples,
profile selection, safe credential input, and background app launch.

### PeekabooBridge (UI automation)

- The built-in agent `computer` tool does **not** use this socket. A paired macOS node fulfills `computer.act` in the app process with embedded Peekaboo services.
- UI automation uses a separate UNIX socket (`~/Library/Application Support/OpenClaw/<socket>`) and the PeekabooBridge JSON protocol.
- Host preference order (client-side): Peekaboo.app -> Claude.app -> OpenClaw.app -> local execution.
- Security: bridge hosts require the exact signed Peekaboo client bundle identifier and Peekaboo's canonical
  current/legacy release signer set; a DEBUG-only same-UID escape hatch is guarded by
  `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo convention).
- See: [PeekabooBridge usage](/platforms/mac/peekaboo) for details.

## Operational flows

- Restart/rebuild: `scripts/restart-mac.sh` kills existing instances, rebuilds via Swift, repackages, and relaunches. It auto-detects an available signing identity and falls back to `--no-sign` if none is found; pass `--sign` to require signing (fails if no key is available) or `--no-sign` to force the unsigned path. An explicit `SIGN_IDENTITY` is preserved through packaging; otherwise `scripts/codesign-mac-app.sh` auto-detects the certificate.
- Single instance: the app checks `NSWorkspace.runningApplications` for a duplicate bundle ID and exits if more than one instance is found (`isDuplicateInstance()` in `MenuBar.swift`).

## Hardening notes

- Prefer requiring a TeamID match for all privileged surfaces.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) may allow same-UID callers for local development.
- All communication remains local-only; no network sockets are exposed.
- TCC prompts originate only from the GUI app bundle; keep the signed bundle ID stable across rebuilds.
- Exec approvals socket hardening: file mode `0600`, shared token stored in the
  `exec_approvals_config` row of `state/openclaw.sqlite`, peer-UID check
  (`getpeereid`), HMAC-SHA256 challenge/response, and a short TTL on requests.

## Related

- [macOS app](/platforms/macos)
- [macOS IPC flow (Exec approvals)](/tools/exec-approvals-advanced#macos-ipc-flow)
