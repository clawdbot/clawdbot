# `@openclaw/gateway-protocol`

Typed schemas, inferred TypeScript types, and runtime validators for the OpenClaw
Gateway WebSocket protocol.

The current wire protocol is version 4. General clients must use v4; authenticated
node clients and lightweight probes may use the N-1 window during rolling upgrades.
See the [Gateway protocol specification](https://docs.openclaw.ai/gateway/protocol)
for transport, authentication, roles, scopes, and complete frame examples.

## Versioning

Package versions follow the OpenClaw calendar release train:
`YYYY.M.PATCH`, with the same prerelease suffix when applicable. A package version
therefore identifies the OpenClaw source release that produced the schemas; it is
not the wire protocol number.

The wire protocol integer is versioned separately. Its current value is exported
as `PROTOCOL_VERSION` from `@openclaw/gateway-protocol/version`. Gateway protocol
changes are additive first. An incompatible wire change requires an explicit
protocol-version decision and coordinated client follow-through. See
[`CHANGELOG.md`](./CHANGELOG.md) for the wire and schema history.

## Install

```bash
npm install @openclaw/gateway-protocol
```

## Entry points

- `@openclaw/gateway-protocol` exports runtime validators, selected schemas, error
  formatting, and their TypeScript types. This is the main TypeBox-backed entry.
- `@openclaw/gateway-protocol/schema` exports the TypeBox schema graph, including
  the `ProtocolSchemas` registry used by generators.
- `@openclaw/gateway-protocol/frame-guards` exports dependency-free structural
  guards for gateway event and response envelopes.
- `@openclaw/gateway-protocol/client-info` exports client ID, mode, and capability
  registries plus normalization helpers.
- `@openclaw/gateway-protocol/connect-error-details` exports structured connect
  error readers and recovery metadata.
- `@openclaw/gateway-protocol/gateway-error-details` exports helpers for reading
  structured details from general gateway errors.
- `@openclaw/gateway-protocol/startup-unavailable` exports startup retry constants
  and helpers.
- `@openclaw/gateway-protocol/version` exports the current and minimum accepted
  protocol versions.

The `frame-guards`, `client-info`, `connect-error-details`, `gateway-error-details`,
`startup-unavailable`, and `version` entry points are TypeBox-free. Prefer them when
a browser bundle only needs envelope dispatch, handshake constants, or reconnect
policy. This also avoids runtime compilation in CSP-sensitive consumers. The root
and `schema` entry points provide the full validation surface and depend on TypeBox.

## Validate an inbound frame

The compiled validators are callable type guards. Their `errors` property contains
the most recent validation errors.

```ts
import { formatValidationErrors, validateRequestFrame } from "@openclaw/gateway-protocol";

const frame: unknown = JSON.parse(inboundText);

if (!validateRequestFrame(frame)) {
  throw new Error(formatValidationErrors(validateRequestFrame.errors));
}

console.log(frame.id, frame.method);
```

`validateRequestFrame` validates the request envelope. Dispatch code must also use
the validator for the selected method's `params`; the root entry point exports those
validators as `validate*Params` functions.

## Guard an event without TypeBox

Use the lightweight guards when code only needs safe frame discrimination. They
check dispatch-critical envelope fields and intentionally allow additive payload
fields.

```ts
import { isGatewayEventFrame } from "@openclaw/gateway-protocol/frame-guards";

const frame: unknown = JSON.parse(inboundText);

if (isGatewayEventFrame(frame)) {
  console.log(frame.event, frame.seq);
}
```

## Build handshake version and capability fields

Protocol levels and client capabilities live in TypeBox-free entry points.

```ts
import { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

const handshake = {
  minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
};
```

Nodes and probes use `MIN_NODE_PROTOCOL_VERSION` and
`MIN_PROBE_PROTOCOL_VERSION`, respectively. A capability advertises client support;
it does not grant authorization.

## Contract notes

### Session identifiers

Several identifier names coexist because they identify different things:

- `key` is the established logical session selector used by most `sessions.*`
  CRUD, send, subscription, patch, reset, delete, compaction, and usage methods.
  A key can be canonicalized or resolved within an agent's session store.
- `sessionKey` names the same logical routing identity where the contract needs to
  make that meaning explicit. `chat.*`, session file and diff APIs, transcript
  branch/rewind/fork APIs, agent events, and channel delivery payloads use this
  spelling.
- `sessionId` is the opaque stored transcript or runtime instance ID. Session
  results may return it beside a key. Talk, terminal, worker, and selected channel
  protocols also use `sessionId` for their own concrete session instances; do not
  substitute a logical session key there.

Follow each method schema rather than converting fields based on their spelling.
`sessions.resolve` is the explicit bridge when a caller has a key, raw session ID,
label, or parent/agent scope.

### Intentionally open fields

The schema graph is strict by default, but roughly 60 fields intentionally use
`Type.Unknown()` passthroughs. The main clusters are transport-owned channel
payloads, logs-chat message and attachment passthrough, worker and node tool
arguments/results, and the dynamic `config.schema` response. Frame `params`,
`payload`, and error `details` are also open at the envelope layer because the
selected method, event, or error code owns their concrete shape.

Do not treat these fields as validated domain objects. Narrow them at their owner
boundary before reading nested values.

### Machine-readable schema

`protocol.schema.json` ships in the npm tarball as the generated machine-readable
contract. It contains the frame union, named schema definitions, and core method
metadata. It is generated during `prepack` and is not committed to the repository.

### Method discovery

The `hello-ok.features.methods` list is conservative discovery, not a complete
enumeration of every callable method. It reflects the methods the connected
Gateway intentionally advertises. Core-internal, role-specific, plugin-provided,
or otherwise non-advertised methods can have valid schemas without appearing in
that list. Clients should use discovery to enable optional UI, not to reject an
otherwise documented method contract.
