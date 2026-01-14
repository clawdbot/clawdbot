---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
---

# Gateway protocol (WebSocket)

The Gateway WS protocol is the **full control plane** for Clawdbot. It is
loopback-only by default and is intended for local clients (CLI, web UI,
automations).

If you are building a **node client** (iOS/Android/macOS node mode), use the
[Bridge protocol](/gateway/bridge-protocol) instead.

## Transport

- WebSocket, text frames with JSON payloads.
- First frame **must** be a `connect` request.

## Handshake (connect)

Client → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "caps": [],
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "clawdbot-cli/1.2.3"
  }
}
```

Gateway → Client:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

## Framing

- **Request**: `{type:"req", id, method, params}`  
- **Response**: `{type:"res", id, ok, payload|error}`  
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

Side-effecting methods require **idempotency keys** (see schema).

## Versioning

- `PROTOCOL_VERSION` lives in `src/gateway/protocol/schema.ts`.
- Clients send `minProtocol` + `maxProtocol`; the server rejects mismatches.
- Schemas + models are generated from TypeBox definitions:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- If `CLAWDBOT_GATEWAY_TOKEN` (or `--token`) is set, `connect.params.auth.token`
  must match or the socket is closed.

## Scope

This protocol exposes the **full gateway API** (status, channels, models,
chat, agent, sessions, nodes, etc.). The exact surface is defined by the
TypeBox schemas in `src/gateway/protocol/schema.ts`.
