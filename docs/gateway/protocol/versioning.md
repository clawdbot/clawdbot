---
summary: "Protocol version constants, the N-1 node window, and client defaults"
read_when:
  - Debugging a protocol version mismatch
  - Setting minProtocol and maxProtocol in a client
  - Checking a client timeout, retry, or buffer default
title: "Gateway protocol versioning"
sidebarTitle: "Versioning"
doc-schema-version: 1
---

Which protocol versions a client may negotiate, and the constants a reference client ships with.

## Versioning

- `PROTOCOL_VERSION`, `MIN_CLIENT_PROTOCOL_VERSION`,
  `MIN_NODE_PROTOCOL_VERSION`, and `MIN_PROBE_PROTOCOL_VERSION` live in
  `packages/gateway-protocol/src/version.ts`.
- Clients send `minProtocol` + `maxProtocol`. Operator and UI clients must
  include the current protocol in that range; current clients and servers run
  protocol v4.
- Authenticated clients with both `role: "node"` and `client.mode: "node"`
  may use the N-1 node protocol (currently v3). Lightweight restart probes use
  the same N-1 window. Device auth, pairing, scopes, command policy, and exec
  approvals are unchanged by this compatibility window. Plugin-owned node
  capabilities and commands are withheld until the node upgrades to the current
  protocol because their hosted surfaces are not part of the N-1 contract.
- Schemas and models are generated from TypeBox definitions:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

### Client constants

The reference client implementation lives in `packages/gateway-client/src/`
(OpenClaw wraps it via the thin `src/gateway/client.ts` facade). These
defaults are stable across protocol v4 and are the expected baseline for
third-party clients.

| Constant                                  | Default                                               | Source                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PROTOCOL_VERSION`                        | `4`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_CLIENT_PROTOCOL_VERSION`             | `4`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_NODE_PROTOCOL_VERSION`               | `3`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_PROBE_PROTOCOL_VERSION`              | `3`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| Request timeout (per RPC)                 | `30_000` ms                                           | `packages/gateway-client/src/client.ts` (`requestTimeoutMs`)                                                              |
| Preauth / connect-challenge timeout       | `15_000` ms                                           | `packages/gateway-client/src/timeouts.ts` (`OPENCLAW_HANDSHAKE_TIMEOUT_MS` env can raise the paired server/client budget) |
| Initial reconnect backoff                 | `1_000` ms                                            | `packages/gateway-client/src/client.ts` (`GATEWAY_RECONNECT_POLICY`)                                                      |
| Max reconnect backoff                     | `30_000` ms                                           | `packages/gateway-client/src/client.ts` (`GATEWAY_RECONNECT_POLICY`)                                                      |
| Fast-retry clamp after device-token close | `250` ms                                              | `packages/gateway-client/src/client.ts`                                                                                   |
| Force-stop grace before `terminate()`     | `250` ms                                              | `FORCE_STOP_TERMINATE_GRACE_MS`                                                                                           |
| `stopAndWait()` default timeout           | `1_000` ms                                            | `STOP_AND_WAIT_TIMEOUT_MS`                                                                                                |
| Default tick interval (pre `hello-ok`)    | `30_000` ms                                           | `packages/gateway-client/src/client.ts`                                                                                   |
| Tick-timeout close                        | code `4000` when silence exceeds `tickIntervalMs * 2` | `packages/gateway-client/src/client.ts`                                                                                   |
| `MAX_PAYLOAD_BYTES`                       | `25 * 1024 * 1024` (25 MB)                            | `src/gateway/server-constants.ts`                                                                                         |
| Chat attachment ceiling                   | `agents.defaults.mediaMaxMb`, default 20 MB decoded   | `src/gateway/chat-attachment-policy.ts`                                                                                   |
| Chat attachment image ceiling             | `min(attachment ceiling, 6 MB)`                       | `src/gateway/chat-attachment-policy.ts`, `packages/media-core/src/constants.ts`                                           |

The server advertises the effective `policy.tickIntervalMs`,
`policy.maxPayload`, `policy.maxBufferedBytes`, and `policy.attachments` in
`hello-ok`; clients should honor those values rather than the pre-handshake
defaults or hardcoded attachment sizes.

The reference client lets finite requests own their configured deadline when
every pending request has one. An `expectFinal` request without a finite
`timeoutMs`, any request with `timeoutMs: null`, or a mix of finite and
unbounded requests keeps the tick watchdog active. If inbound events and
responses remain silent past the tick-timeout threshold, the client closes the
socket with code `4000`, rejects every pending request, and reconnects. It does
not replay rejected requests after reconnecting.
