# `@openclaw/gateway-client`

Reference WebSocket client for the OpenClaw Gateway protocol. It provides the
connection state machine used by OpenClaw's own Node and browser clients:
challenge-based authentication, typed protocol frames, request correlation,
timeouts, reconnect backoff, device-token handling, and event delivery.

The current wire protocol is version 4. General clients must negotiate v4 with
`minProtocol: 4` and `maxProtocol: 4`. See the
[Gateway protocol specification](https://docs.openclaw.ai/gateway/protocol) for
the complete handshake, authentication, role, scope, and method contracts.

## Versioning

Package versions follow the OpenClaw calendar release train: `YYYY.M.PATCH`,
including the OpenClaw prerelease suffix when applicable. The package version is
separate from the negotiated wire protocol number.

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
Gateway accepts the v4 connection, so requests should wait for that callback.

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
- Device identity persistence, signing, proxy routing, TLS formatting, and
  logging stay host-owned through `GatewayClientHostDeps`.
- Protocol changes are additive first. Incompatible changes require an explicit
  wire-version decision and coordinated server/client follow-through.
