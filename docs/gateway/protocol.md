---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
title: "Gateway protocol"
doc-schema-version: 1
---

The Gateway WS protocol is the single control plane and node transport for
OpenClaw. Operator and node clients (CLI, web UI, macOS app, iOS/Android nodes,
headless nodes) connect over WebSocket and declare a **role** and **scope** at
handshake time.

## Scope

This protocol exposes the full gateway API: status, channels, models, chat,
agent, sessions, nodes, approvals, and more. The exact surface is defined by
the TypeBox schemas re-exported from `packages/gateway-protocol/src/schema.ts`.

## What each page covers

- [Transport and framing](/gateway/protocol/transport) — gateway WS transport: packages, frame shapes, limits, and WebRTC Talk control.
- [Handshake and roles](/gateway/protocol/handshake) — connect frame, hello-ok payload, client capabilities, roles, and scopes.
- [Presence and events](/gateway/protocol/presence) — presence snapshots, node host stats, and broadcast event scoping.
- [RPC methods](/gateway/protocol/rpc-methods) — RPC method families, discovery, session list bootstrap, and event families.
- [Ledger RPCs](/gateway/protocol/ledgers) — audit ledger and task ledger RPCs, their scopes, cursors, and payloads.
- [Operator methods](/gateway/protocol/operator-methods) — operator helper methods, exec approvals, and agent delivery fallback.
- [Versioning](/gateway/protocol/versioning) — protocol version constants, the N-1 node window, and client defaults.
- [Auth and device identity](/gateway/protocol/auth) — handshake auth paths, device identity, pairing signatures, and TLS pinning.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link to this page with a fragment still resolves. Each entry points at the page that now holds the content.

- <a id="npm-packages" />[npm packages](/gateway/protocol/transport#npm-packages)
- <a id="transport-and-framing" />[Transport and framing](/gateway/protocol/transport#transport-and-framing)
- <a id="gateway-controlled-webrtc-talk" />[Gateway-controlled WebRTC Talk](/gateway/protocol/transport#gateway-controlled-webrtc-talk)
- <a id="handshake" />[Handshake](/gateway/protocol/handshake#handshake)
- <a id="worker-role-and-closed-protocol" />[Worker role and closed protocol](/gateway/protocol/handshake#worker-role-and-closed-protocol)
- <a id="client-capabilities" />[Client capabilities](/gateway/protocol/handshake#client-capabilities)
- <a id="node-connect-example" />[Node connect example](/gateway/protocol/handshake#node-connect-example)
- <a id="roles-and-scopes" />[Roles and scopes](/gateway/protocol/handshake#roles-and-scopes)
- <a id="caps%2Fcommands%2Fpermissions-(node)" />[Caps/commands/permissions (node)](</gateway/protocol/handshake#caps%2Fcommands%2Fpermissions-(node)>)
- <a id="caps/commands/permissions-node" />[Caps/commands/permissions (node)](/gateway/protocol/handshake#caps/commands/permissions-node)
- <a id="presence" />[Presence](/gateway/protocol/presence#presence)
- <a id="node-host-stats" />[Node host stats](/gateway/protocol/presence#node-host-stats)
- <a id="node-background-alive-event" />[Node background alive event](/gateway/protocol/presence#node-background-alive-event)
- <a id="broadcast-event-scoping" />[Broadcast event scoping](/gateway/protocol/presence#broadcast-event-scoping)
- <a id="rpc-method-families" />[RPC method families](/gateway/protocol/rpc-methods#rpc-method-families)
- <a id="system-and-identity" />[System and identity](/gateway/protocol/rpc-methods#system-and-identity)
- <a id="models-and-usage" />[Models and usage](/gateway/protocol/rpc-methods#models-and-usage)
- <a id="channels-and-login-helpers" />[Channels and login helpers](/gateway/protocol/rpc-methods#channels-and-login-helpers)
- <a id="plugin-management" />[Plugin management](/gateway/protocol/rpc-methods#plugin-management)
- <a id="messaging-and-logs" />[Messaging and logs](/gateway/protocol/rpc-methods#messaging-and-logs)
- <a id="operator-terminal" />[Operator terminal](/gateway/protocol/rpc-methods#operator-terminal)
- <a id="talk-and-tts" />[Talk and TTS](/gateway/protocol/rpc-methods#talk-and-tts)
- <a id="secrets-config-update-and-wizard" />[Secrets, config, update, and wizard](/gateway/protocol/rpc-methods#secrets-config-update-and-wizard)
- <a id="agent-and-workspace-helpers" />[Agent and workspace helpers](/gateway/protocol/rpc-methods#agent-and-workspace-helpers)
- <a id="session-control" />[Session control](/gateway/protocol/rpc-methods#session-control)
- <a id="device-pairing-and-device-tokens" />[Device pairing and device tokens](/gateway/protocol/rpc-methods#device-pairing-and-device-tokens)
- <a id="node-pairing-invoke-and-pending-work" />[Node pairing, invoke, and pending work](/gateway/protocol/rpc-methods#node-pairing-invoke-and-pending-work)
- <a id="approval-families" />[Approval families](/gateway/protocol/rpc-methods#approval-families)
- <a id="control-ui-commands" />[Control UI commands](/gateway/protocol/rpc-methods#control-ui-commands)
- <a id="automation-skills-and-tools" />[Automation, skills, and tools](/gateway/protocol/rpc-methods#automation-skills-and-tools)
- <a id="session-list-bootstrap" />[Session list bootstrap](/gateway/protocol/rpc-methods#session-list-bootstrap)
- <a id="common-event-families" />[Common event families](/gateway/protocol/rpc-methods#common-event-families)
- <a id="node-helper-methods" />[Node helper methods](/gateway/protocol/rpc-methods#node-helper-methods)
- <a id="node-exec-lifecycle-events" />[Node exec lifecycle events](/gateway/protocol/rpc-methods#node-exec-lifecycle-events)
- <a id="audit-ledger-rpc" />[Audit ledger RPC](/gateway/protocol/ledgers#audit-ledger-rpc)
- <a id="task-ledger-rpcs" />[Task ledger RPCs](/gateway/protocol/ledgers#task-ledger-rpcs)
- <a id="operator-helper-methods" />[Operator helper methods](/gateway/protocol/operator-methods#operator-helper-methods)
- <a id="models.list-views" />[`models.list` views](/gateway/protocol/operator-methods#models.list-views)
- <a id="models-list-views" />[`models.list` views](/gateway/protocol/operator-methods#models-list-views)
- <a id="exec-approvals" />[Exec approvals](/gateway/protocol/operator-methods#exec-approvals)
- <a id="agent-delivery-fallback" />[Agent delivery fallback](/gateway/protocol/operator-methods#agent-delivery-fallback)
- <a id="versioning" />[Versioning](/gateway/protocol/versioning#versioning)
- <a id="client-constants" />[Client constants](/gateway/protocol/versioning#client-constants)
- <a id="auth" />[Auth](/gateway/protocol/auth#auth)
- <a id="device-identity-and-pairing" />[Device identity and pairing](/gateway/protocol/auth#device-identity-and-pairing)
- <a id="device-auth-migration-diagnostics" />[Device auth migration diagnostics](/gateway/protocol/auth#device-auth-migration-diagnostics)
- <a id="tls-and-pinning" />[TLS and pinning](/gateway/protocol/auth#tls-and-pinning)

## Related

- [Building a Gateway client](https://docs.openclaw.ai/gateway/clients)
- [Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)
- [Gateway runbook](/gateway)
