---
summary: "macOS IPC architecture for OpenClaw app, gateway node transport, and PeekabooBridge"
read_when:
  - Editing IPC contracts or menu bar app IPC
title: "macOS IPC"
---

# OpenClaw macOS IPC architecture

A local Unix socket connects the node host service to the macOS app for exec approvals and `system.run`. An `openclaw-mac` debug CLI (`apps/macos/Sources/OpenClawMacCLI`) exists for discovery/connect checks; agent actions still flow through the Gateway WebSocket and `node.invoke`. The node-backed `computer.act` path runs embedded Peekaboo automation in-process; standalone Peekaboo clients use PeekabooBridge.

## Goals

- Single GUI app instance that owns all TCC-facing work (notifications, screen recording, mic, speech, AppleScript).
- A small surface for automation: Gateway + node commands, in-process `computer.act`, plus PeekabooBridge for standalone UI automation clients.
- Predictable permissions: always the same signed bundle ID, launched by launchd, so TCC grants stick.

## How it works

### Gateway + node transport

- The app runs the Gateway (local mode) and connects to it as a node.
- Agent actions are performed via `node.invoke` (e.g. `system.run`, `system.notify`, `canvas.*`).
- Node commands include `canvas.*`, `camera.snap`, `camera.clip`, `screen.snapshot`, `screen.record`, `computer.act`, `system.run`, and `system.notify`.
- The node reports a `permissions` map so agents can see whether screen, camera, microphone, speech, automation, or accessibility access is available.

### Node service + app IPC

- A headless node host service connects to the Gateway WebSocket.
- `system.run` requests are forwarded to the macOS app over a local Unix socket (`ExecApprovalsSocket.swift`).
- The app performs the exec in UI context, prompts if needed, and returns output.

Diagram (SCI):

```text
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI automation)

- The built-in agent `computer` tool does **not** use this socket. A paired macOS node fulfills `computer.act` in the app process with embedded Peekaboo services.
- UI automation uses a separate UNIX socket (`~/Library/Application Support/OpenClaw/<socket>`) and the PeekabooBridge JSON protocol.
- Host preference order (client-side): Peekaboo.app -> Claude.app -> OpenClaw.app -> local execution.
- Security: bridge hosts require an allowlisted TeamID (the bundled `PeekabooBridgeHostCoordinator` allowlists a fixed team plus the app's own signing team); a DEBUG-only same-UID escape hatch is guarded by `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo convention).
- See: [PeekabooBridge usage](/platforms/mac/peekaboo) for details.

## Operational flows

- Restart/rebuild: `scripts/restart-mac.sh` kills existing instances, rebuilds via Swift, repackages, and relaunches. It auto-detects an available signing identity and falls back to `--no-sign` if none is found; pass `--sign` to require signing (fails if no key is available) or `--no-sign` to force the unsigned path. `SIGN_IDENTITY` set in the environment is unset on the signed path, so `scripts/codesign-mac-app.sh`'s own identity auto-detection picks the cert.
- Single instance: the app checks `NSWorkspace.runningApplications` for a duplicate bundle ID and exits if more than one instance is found (`isDuplicateInstance()` in `MenuBar.swift`).

## Hardening notes

- Prefer requiring a TeamID match for all privileged surfaces.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) may allow same-UID callers for local development.
- All communication remains local-only; no network sockets are exposed.
- TCC prompts originate only from the GUI app bundle; keep the signed bundle ID stable across rebuilds.
- Exec approvals socket hardening: file mode `0600`, shared token, peer-UID check (`getpeereid`), HMAC-SHA256 challenge/response, and a short TTL on requests.

## Related

- [macOS app](/platforms/macos)
- [macOS IPC flow (Exec approvals)](/tools/exec-approvals-advanced#macos-ipc-flow)
