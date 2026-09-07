---
summary: "Gateway WS transport: packages, frame shapes, limits, and WebRTC Talk control"
read_when:
  - Choosing the gateway protocol or client package to install
  - Sizing frames, payload limits, or compression behavior
  - Implementing Gateway-controlled WebRTC Talk
title: "Gateway protocol transport"
sidebarTitle: "Transport and framing"
doc-schema-version: 1
---

What the wire looks like before any method call: the published packages, the frame shapes, the payload limits, and the Gateway-controlled WebRTC Talk contract.

## npm packages

The verified stable package release is `2026.8.1`. Follow
[Install the packages](/gateway/clients#install-the-packages) for exact-version
commands and compatibility guidance. Package release versions are separate from
the wire protocol version and the root `openclaw` CLI release.

- [`@openclaw/gateway-protocol`](https://www.npmjs.com/package/@openclaw/gateway-protocol)
  publishes the schemas, validators, TypeScript types, lightweight frame and error
  helpers, and version constants. Its tarball includes the generated
  [`protocol.schema.json`](https://unpkg.com/@openclaw/gateway-protocol@2026.8.1/protocol.schema.json)
  machine-readable contract as a downloadable file, not an exported import subpath.
- [`@openclaw/gateway-client`](https://www.npmjs.com/package/@openclaw/gateway-client)
  publishes the reference Node client and a browser-safe entry at
  `@openclaw/gateway-client/browser`.

For application lifecycle guidance, see
[Building a Gateway client](https://docs.openclaw.ai/gateway/clients). For apps
that supervise the Gateway as a child process, see
[Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding).

## Transport and framing

- WebSocket, text frames, JSON payloads.
- First frame **must** be a `connect` request.
- Pre-connect frames are capped at 64 KiB (`MAX_PREAUTH_PAYLOAD_BYTES`). After
  handshake, follow `hello-ok.policy.maxPayload` and
  `hello-ok.policy.maxBufferedBytes`. With diagnostics enabled, oversized
  inbound frames and slow outbound buffers emit `payload.large` events before
  the gateway closes or drops the frame. These events carry `surface`, byte
  sizes, limits, and a safe reason code, never message bodies, attachment
  contents, raw frame bytes, tokens, cookies, or secrets.
- The Gateway offers `permessage-deflate`. Peers that negotiate it (browsers, `ws`
  clients) receive frames of 4 KiB and up compressed; smaller frames such as
  streaming deltas stay raw. Context takeover is disabled in both directions, so
  each frame compresses independently. Peers that do not offer the extension are
  unaffected. Payload limits apply to the inflated size.

Frame shapes:

- Request: `{type:"req", id, method, params, traceparent?}`
- Response: `{type:"res", id, ok, payload|error}`
- Event: `{type:"event", event, payload, seq?, stateVersion?}`

After authentication, a client may include a W3C `traceparent` string on each
request frame. The Gateway continues a valid value as a child trace context for
that request. Missing or syntactically malformed values within the
128-character field limit keep the default fresh request trace and do not fail
the RPC; longer values make the request frame invalid. The initial `connect`
request never establishes trace context for later frames. Use a separate
`traceparent` for each logical request on a long-lived connection; do not treat
the WebSocket itself as one trace.

Response errors use `{ code, message, details?, retryable?, retryAfterMs? }`.
Authenticated operator requests share a bounded queue for starting RPC handlers.
When waiting capacity is exhausted, the Gateway returns retryable `UNAVAILABLE`
before the method runs; retry within the request's budget. Started requests
complete concurrently, so responses can arrive out of order.

Ordinary UI/SDK requests may outlive a socket disconnect, but cannot start a
handler in a retiring Gateway instance. Shutdown fences new request entry and
joins pending handler loading and authorization before releasing their runtime.
Already-started methods retain their own shutdown behavior; shutdown does not
wait for every RPC to finish. Exact pending node progress and result replies
remain available during node cleanup, until transport shutdown seals entry.

Clients should branch on `code` and `details.code`; `message` remains human-readable
and can change except where a compatibility note says otherwise. Method-level
authorization failures use top-level `code: "FORBIDDEN"` with structured
missing-scope details:

- Missing scope: `{ code: "MISSING_SCOPE", missingScope, requiredScopes }`.
  `requiredScopes` is the complete known scope set for the requested operation.
  The legacy `missing scope: <scope>` message is retained for older clients.

Clients should read `details` first and use the legacy message only as a compatibility
fallback. `readMissingScopeError` and `readMissingScopeErrorDetails` are exported from
`@openclaw/gateway-protocol/gateway-error-details`; the browser-safe gateway client
re-exports them from `@openclaw/gateway-client/browser`.

The schemas are exported as `GatewayErrorDetailsSchema`,
`MissingScopeErrorDetailsSchema` from `@openclaw/gateway-protocol/schema`.
HTTP scope failures mirror the `MISSING_SCOPE` object under `error.details` and
use HTTP status `403`.

Side-effecting methods require idempotency keys (see schema).

## Gateway-controlled WebRTC Talk

`talk.client.create` accepts the additive capability `gateway-control-v1`.
The released browser/Gateway-owned WebRTC route tries OAuth first and falls
back to Platform API-key authentication. Direct backend sockets and unlisted
or private realtime routes require Platform API-key authentication. A
successful result includes
`clientControl: { owner: "gateway" }`, a 60-second single-use Gateway broker
token in `clientSecret`, and the relative
`offerUrl: "/plugins/openai/realtime/calls"`.

The client sends only `application/sdp` to that route with the broker token. It
must not create a provider control data channel. The Gateway creates the call,
attaches the provider sideband before returning the answer SDP, and owns tool,
transcript, steering, cancellation, and close lifecycle. Clients that omit the
capability retain the existing browser session behavior. A Gateway or
configured authentication path that cannot provide the requested owner returns
`UNAVAILABLE`; it never downgrades the request to client-owned control.

Clients must close their local media peer if the Gateway connection is lost or
a `talk.event` for their current `voiceSessionId` contains
`talkEvent.type: "session.closed"`. Ignore terminal events for other calls;
a recoverable `session.error` alone is not a close notification.
