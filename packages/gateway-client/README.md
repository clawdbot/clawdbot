# `@openclaw/gateway-client`

Reference WebSocket client for the OpenClaw Gateway protocol. It provides the
connection state machine used by OpenClaw's own Node and browser clients:
challenge-based authentication, typed protocol frames, request correlation,
timeouts, reconnect backoff, device-token handling, and event delivery.

The current wire protocol is version 4. General clients must advertise exactly v4 with
`minProtocol: 4` and `maxProtocol: 4`. See the
[Gateway protocol specification](https://docs.openclaw.ai/gateway/protocol) for
the complete handshake, authentication, role, scope, and method contracts.
Exact node identities (`role: "node"` plus `mode: "node"`) and probe clients
can use v3. The built-in node host starts with an exact v4 envelope, then retries
an exact v3 envelope after a v3 Gateway rejects v4. If that legacy probe reaches
an upgraded v4 Gateway, the client reconnects with the full v4 envelope before
reporting readiness. Other exact node identities default to `[3, 4]`. Explicit
bounds override these defaults; `[3, 4]` on the built-in node host selects the
same bounded negotiation.

## Versioning

Package versions follow the OpenClaw calendar release train: `YYYY.M.PATCH`,
including the OpenClaw prerelease suffix when applicable. The package version is
separate from the Gateway's current wire protocol number reported in `hello-ok`.

## Install

```bash
npm install @openclaw/gateway-client @openclaw/gateway-protocol
```

Node consumers use the `ws` transport included as a runtime dependency. Browser
consumers provide their platform WebSocket through the browser-safe protocol
client surface.

## Entry points

- `@openclaw/gateway-client` exports the Node `GatewayClient`, device-auth
  helpers, readiness helpers, and timeout utilities.
- `@openclaw/gateway-client/browser` exports the browser-safe protocol client,
  browser device-auth lifecycle, reconnect policy, and lightweight protocol
  constants. Its module graph does not import Node built-ins or `ws`.
- `@openclaw/gateway-client/readiness` exports helpers that delay client startup
  until the event loop can process Gateway IO.
- `@openclaw/gateway-client/timeouts` exports timeout constants and safe timer
  resolution helpers.
- `@openclaw/gateway-client/websocket-data` converts every Node `ws` raw-data
  shape to UTF-8 text.

## Node quickstart

```ts
import { GatewayClient } from "@openclaw/gateway-client";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

const connected = Promise.withResolvers<void>();
const client = new GatewayClient({
  url: "ws://127.0.0.1:18789",
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  minProtocol: PROTOCOL_VERSION, // v4
  maxProtocol: PROTOCOL_VERSION, // v4
  onHelloOk: () => connected.resolve(),
  onConnectError: (error) => connected.reject(error),
  onEvent: (event) => {
    console.log(event.event, event.payload);
  },
});

client.start();
await connected.promise;

const status = await client.request("status", {});
console.log(status);

client.stop();
```

The client waits for the Gateway's `connect.challenge` event before sending its
`connect` request. It includes the challenge nonce in device authentication and
does not fall back to a pre-challenge handshake. `onHelloOk` fires only after the
Gateway accepts a compatible connection, so requests should wait for that callback.

For remote connections, use `wss://`. Plaintext `ws://` is allowed by default
only for loopback addresses. Authentication material and Gateway traffic must
not cross an untrusted network without transport security.

## Browser clients

Import `@openclaw/gateway-client/browser` when the host owns the WebSocket
adapter and device-key storage. The browser entry includes
`GatewayProtocolClient` and `GatewayBrowserDeviceAuthLifecycle`; it deliberately
omits the Node transport, TLS fingerprint handling, and private-network address
policy.

The host is responsible for:

- creating a `GatewayProtocolSocket` adapter around the browser WebSocket;
- loading and storing browser device identity and issued device tokens;
- signing the challenge-bound device payload;
- using the Gateway challenge `ts` as the device proof's `signedAt` value;
- supplying the client identity, role, scopes, and authentication selection;
- choosing close and reconnect behavior for product-specific errors.

The shared protocol client still owns frame parsing, request correlation,
challenge ordering, timeout cleanup, sequence-gap detection, and reconnect
scheduling.

## Defaults and reconnect behavior

The Node client starts with a 30 second request timeout, a 15 second
connect-challenge timeout, and exponential reconnect delays from 1 second to 30
seconds with a multiplier of 2. Server-provided startup retry hints may override
the next delay.

The canonical defaults table and the server policy fields that can replace
pre-handshake values are documented in the
[Gateway protocol specification](https://docs.openclaw.ai/gateway/protocol#client-constants).

Use the `./timeouts` entry point when a host must align readiness or watchdog
budgets with these defaults. Use the `./readiness` entry point when startup must
wait for an event-loop probe before opening the socket.

## Bundled internals

The retry supervisor and the small `@openclaw/net-policy/ip` implementation are
inlined into the published JavaScript and declarations. They are implementation
details, not public exports or supported API surfaces. `ipaddr.js` remains an
external dependency because the inlined IP helpers use its public runtime and
types.

`ws`, `@openclaw/gateway-protocol`, and `ipaddr.js` remain external in the
published distribution. Consumers should import protocol types and constants
from `@openclaw/gateway-protocol`, not from bundled implementation paths.

## Contract notes

- The client is inert at module import and construction time. `start()` opens
  the socket; `stop()` closes it and rejects pending requests.
- A request uses `request(method, params)` after `hello-ok`. Passing
  `timeoutMs: null` creates an intentionally unbounded request.
- Finite request deadlines reject with `GatewayProtocolRequestTimeoutError`,
  whose `CLIENT_TIMEOUT` code, method, deadline, and send-boundary flag remain
  distinct from authoritative Gateway response errors.
- Device identity persistence, signing, proxy routing, TLS formatting, and
  logging stay host-owned through `GatewayClientHostDeps`.
- Protocol changes are additive first. Incompatible changes require an explicit
  wire-version decision and coordinated server/client follow-through.

## Higher-level control model (`@openclaw/gateway-client/model`)

Framework-neutral state and command projections above
`@openclaw/gateway-client`.

The proposed public model subpaths own connection lifecycle, immutable session
catalog snapshots, and OC2 conversation projections. They do not include UI
artifacts or framework adapters. The `./model` subpaths remain review-gated
until RFC 0029 accepts their public compatibility and release ownership.

## Bind a Gateway client

Hosts adapt their existing Gateway connection to `ControlModelGatewayBinding`:

```ts
import { createControlModel } from "@openclaw/gateway-client/model";

const model = createControlModel({
  gateway: {
    getConnectionSnapshot: () => connectionSnapshot,
    subscribeConnection: (listener) => connectionStore.subscribe(listener),
    subscribeSessionCatalogInvalidations: (listener) =>
      sessionCatalogInvalidations.subscribe(listener),
    subscribeEvents: (listener) => {
      const connectionEpoch = connectionSnapshot.epoch;
      return gateway.subscribeEvents((frame) => listener({ ...frame, connectionEpoch }));
    },
    getMessageSubscriptionCoordinator: () =>
      getGatewaySessionMessageSubscriptionCoordinator(gateway, {
        keysEquivalent: areHostSessionKeysEquivalent,
      }),
    request: (method, params, options) => gateway.request(method, params, options),
  },
});

model.start();
const unsubscribe = model.subscribe(() => {
  render(model.getSnapshot());
});
```

The binding supplies monotonically increasing connection epochs. A response
captured under a retired epoch never replaces state from the current
connection.

The invalidation binding remains responsible for the session-catalog
subscription and authorized `sessions.changed` invalidations. The host injects
the canonical Gateway Client coordinator already owned by its live connection;
Control Model acquires and releases only its own targeted leases and never
resets that shared coordinator. The host must retire and replace the coordinator
before publishing a new connection epoch.

`subscribeEvents` adapts ordinary protocol `EventFrame` values at the
host-owned connection boundary. Capture that connection's epoch when installing
the listener and stamp every forwarded frame, as above, so stale frames cannot
cross a reconnect.

## Session snapshots

`model.refreshSessions()` requests one bounded `sessions.list` result and
publishes a deeply frozen snapshot. Live `sessions.changed` events schedule a
canonical refresh; they do not mutate rows directly. Control Model exports the
same bounded refresh coordinator used by Control UI, so both surfaces preserve
one trailing refresh after an in-flight request succeeds or fails.

Subscriber notifications run in a coalesced microtask. A slow or throwing
subscriber cannot block the Gateway event callback or prevent other subscribers
from observing the current snapshot.

Call `model.dispose()` before releasing the host connection.

## OC2 conversations

`model.conversation(sessionKey)` returns a stable, lazy
`ControlModelConversation` handle. Handles expose immutable snapshots and
coalesced subscriptions, plus `refreshHistory`, `loadMoreHistory`, `send`,
`abort`, `resolveApproval`, `answerQuestion`, `cancelQuestion`, and `release`.
An unsubscribed, operation-idle handle may be evicted and disposed when the
finite inactive-handle bound is reached; subscribe to pin a handle or call
`release` explicitly when it is no longer needed. Conversation history is
reconciled through the canonical Gateway Client session projection, while live
events are accepted only from the current connection epoch.
`ControlModelCommandError` provides bounded, typed command failures.

Hosts must implement the framework-neutral event seam:

```ts
subscribeEvents(listener) => () => void
```

Each frame contains `event`, `payload`, and the source `connectionEpoch`, with
optional `seq` and explicit `gap`. The host owns connection epochs; the model
rejects frames from retired epochs and releases only its own leases. The host
retires and replaces the shared Gateway Client message subscription coordinator
when a connection is replaced.
