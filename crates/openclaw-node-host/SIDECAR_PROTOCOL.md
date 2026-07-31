# OpenClaw node sidecar protocol v1

This document describes the byte contract implemented by
`sidecar_protocol.rs`. It is the portable authenticated channel beneath a
future node-runtime message schema. It does not select named pipes, Unix
sockets, inherited anonymous pipes, or another local transport.

## Trust before this protocol

The product supervisor must verify the exact runtime artifact and create a
fresh local-only IPC endpoint before launch. It supplies a random 32-byte
session key, session identifier, and nonzero generation over a protected
bootstrap mechanism. Those values must not be placed in command-line
arguments, broadly inherited environment variables, logs, crash reports, or
world-readable files.

This crate intentionally does not implement platform artifact verification,
secret delivery, process creation, secure storage, or runtime selection. A
peer identity reported inside this protocol is authenticated by the session
key but is not proof that the executable on disk was trusted.

## Length prefix and local ceiling

Each frame is preceded by an unsigned four-byte big-endian length. The length
counts the authenticated frame and excludes the prefix. A receiver must apply
its local hard ceiling to the prefix before allocating or reading the frame.
The prefix is not security authority: all internal lengths and fields are
covered by the authentication tag.

The bootstrap exchange always uses protocol minor `0`, the same
pre-negotiation ceiling, and a finite deadline. This lets an older peer read a
newer peer's offer before minor-version negotiation. Negotiated limits are the
minimum of both valid local offers and can never raise a local ceiling. After
the final bootstrap frame, both peers apply the independently verified minor
and frame limit to the active authenticated channel so directional sequence
numbers are not reset.

## Authenticated frame

All integers are unsigned and big-endian.

| Field              |    Bytes | Meaning                                              |
| ------------------ | -------: | ---------------------------------------------------- |
| Magic              |        4 | ASCII `OCSC`                                         |
| Protocol major     |        2 | `1`                                                  |
| Protocol minor     |        2 | `0` during bootstrap; negotiated minor afterward     |
| Direction          |        1 | `1` supervisor-to-runtime, `2` runtime-to-supervisor |
| Generation         |        8 | Nonzero process/session generation                   |
| Sequence           |        8 | Strictly increasing per direction, starting at `1`   |
| Session ID length  |        2 | UTF-8 byte length                                    |
| Payload length     |        4 | JSON payload byte length                             |
| Session ID         | variable | Exact bootstrap session identifier                   |
| Payload            | variable | UTF-8 JSON; the next slice defines typed messages    |
| Authentication tag |       32 | HMAC-SHA-256 over every preceding frame byte         |

The frame limit includes the authentication tag and excludes the outer length
prefix. The sender and receiver use the same session key; direction is part of
the authenticated header and prevents reflection between peers.

Outbound JSON is serialized directly into the final frame through the local
ceiling. Serialization stops on the first write that would consume the bytes
reserved for the authentication tag; an oversized payload is never fully
materialized or copied into a second plaintext buffer.

A receiver verifies the frame-size ceiling and HMAC before interpreting any
untrusted header or payload field. It then verifies version, direction,
generation, exact next sequence, session identifier, internal lengths, and
payload decoding. Any failure retires the channel; callers must not continue
after a framing, authentication, replay, or generation error. The Rust channel
poisons itself on the first inbound validation failure and rejects every later
send or receive. A transport owner calls `retire()` when length-prefix I/O or
its surrounding IPC transport fails.

A new process gets a new session identifier, key, generation, and sequence
space. A sequence gap or replay is rejected rather than buffered. Rotate the
generation before sequence exhaustion; never reset a sequence in place.

## Negotiation

`SidecarProtocolOffer` carries the peer role and reported identity, protocol
version, additive feature bits, frame/in-flight ceilings, and bootstrap
deadline. Peers must have complementary roles and the same major version.
Features are intersected. The feature mask must be at most `2^53 - 1`, the
largest integer that JSON implementations such as JavaScript can preserve
exactly; larger local or remote offers are invalid. Frame, in-flight, and
deadline values use the lower valid offer. Unknown features remain disabled.
Adapters must perform the intersection with integer arithmetic that preserves
all 53 bits. JavaScript and TypeScript implementations must convert both masks
to `BigInt` before `&` and convert the bounded result back to `Number`; their
native number `&` operator truncates operands to 32 bits and is not conformant.

The supervisor initiates with an authenticated `offer`. The runtime
independently negotiates against its local offer and replies with one
authenticated `accept` containing its offer and the selected parameters. The
supervisor independently recomputes the selection; a mismatch is terminal.
The runtime remains in `AcceptancePending` and retains the bootstrap ceiling
until the acceptance is written successfully. It then commits the selection;
the supervisor commits only after receiving and verifying that frame. This
prevents active traffic from racing ahead of the acceptance and ensures an
acceptance larger than the negotiated ceiling can still be delivered. Both
peers preserve the existing directional sequence state.

The `SidecarHandshake` state machine is bound to one exact authenticated
channel instance and accepts only this two-frame ordering. Substituting another
channel is rejected before frame processing or handshake mutation and retires
the supplied replacement; the original bound handshake can continue.
Wrong roles, incompatible versions, malformed/authentication failures, forged
selection, repeated/out-of-order messages, and unencodable bootstrap messages
retire the handshake and channel. Negotiation must complete before accepting
credentials, configuration, capability registration, or invocation traffic.

## Cross-language vector

[`node-sidecar-protocol-v1.json`](../../test/fixtures/node-sidecar-protocol-v1.json)
contains a test-only session key, payload, and exact encoded data frame.
[`node-sidecar-negotiation-v1.json`](../../test/fixtures/node-sidecar-negotiation-v1.json)
exercises a feature bit above the 32-bit JavaScript bitwise range.
[`node-sidecar-handshake-v1.json`](../../test/fixtures/node-sidecar-handshake-v1.json)
contains both offers, the independently derived selection, and exact offer and
accept frames. Rust tests reproduce and decode every vector. Every non-Rust
adapter must consume the same vectors before it can be selected as a runtime.

[`node-sidecar-runtime-v1.json`](../../test/fixtures/node-sidecar-runtime-v1.json)
contains the typed configuration, configured acknowledgement, admission,
invocation, result, cancellation, and status messages plus their exact compact
JSON encodings. These payloads travel inside the already authenticated,
sequenced frames; the message corpus does not replace the frame vectors.
All integer fields, including integers nested inside invocation parameters or
success payloads, must remain in JSON's exact `-(2^53 - 1)..=2^53 - 1` range.
Serialization and deserialization reject values outside that range; the shared
corpus exercises the positive boundary. Integer-valued decimal or exponent
forms follow the same bound; genuine fractional JSON numbers retain their
normal finite IEEE-754 semantics. Runtime adapter traffic reports the
distinct `SIDECAR_NON_PORTABLE_JSON` failure rather than misclassifying these
values as oversized payloads.

## Runtime bridge

`SidecarRuntimeBridge` can be constructed only from the runtime side after the
validated configuration acknowledgement has been written successfully. The
runtime remains `AcknowledgementPending` until that delivery is committed, so
invocation work cannot race ahead of the supervisor-visible manifest. The
configuration exchange is consumed from its authenticated handshake, and a
successful activation irreversibly moves it to `Activated`; neither phase can
be replayed to multiply concurrency. Beginning configuration locks the
negotiated frame ceiling for the rest of the channel generation, so bridge
preflight budgets cannot become stale. Activation also requires the exact live
authenticated channel. The bridge carries that channel's retirement signal:
retirement blocks new native work and cancels in-flight adapter work. The bridge
accepts one immutable connection manifest and requires its
concurrency/input/output limits to remain within the negotiated sidecar envelope. Command and capability names
use the shared ASCII grammar `[A-Za-z0-9._-]{1,128}`, are duplicate-free, and
are sorted bytewise before acknowledgement; the OpenClaw-owned `system.*`
namespace remains reserved.

The configured output limit must also fit the largest bridge-owned stable
failure envelope. This preserves `SIDECAR_MESSAGE_TOO_LARGE`,
`SIDECAR_NON_PORTABLE_JSON`, and `SIDECAR_CHANNEL_RETIRED` instead of allowing
the generic command-runtime output limiter to rewrite them.

`SidecarConfigurationExchange` permits exactly one supervisor configuration
followed by the runtime's acknowledgement of the independently derived
manifest. It remains bound to the exact channel instance authenticated by the
handshake; a replacement is retired before processing without mutating the
bound exchange. Wrong order, channel role, malformed or unknown fields,
invalid limits/names, and a forged acknowledgement retire the exchange and channel.
It also proves the worst-case secret-free status envelope—including the runtime
version from the authenticated offer—fits the lowered live-channel budget. No
admission or invocation message is accepted by this exchange.

The bridge builds the existing bounded `CommandRuntime`. Every invocation
therefore passes its normal Gateway-manifest, input, concurrency, timeout,
admission, handler, output, and cancellation gates. The product-owned
`SidecarCapabilityAdapter` receives an untrusted typed invocation first for
local admission and only then for native dispatch. A denial or adapter failure
becomes a bounded structured handler failure. The runtime cancellation token is
passed through both waits so product adapter work can stop on Gateway cancel,
timeout, disconnect, or shutdown.

Logical parameter and result limits are not treated as complete-frame limits.
Before cloning Gateway JSON into an adapter request, and without cloning an
adapter decision/result, the bridge runs a borrowed non-allocating serialization
preflight for the complete admission, invocation, decision, or result message
against the live channel's exact payload budget
(frame ceiling minus fixed header, session identifier, and authentication tag).
Adapter infrastructure errors are first normalized into the same denial or
failure wire shape, so they cannot bypass the complete-message preflight.
A value that fits its logical JSON limit but not its full envelope receives the
stable `SIDECAR_MESSAGE_TOO_LARGE` result without attempting transport.

The bridge also maps secret-free `NodeLifecycle` events into stable status
states and reasons correlated with the immutable manifest generation. A
capability change requires a new bridge and connection/process generation;
registrations cannot be mutated in place after advertisement.

## Not yet implemented

This stack still excludes a concrete IPC driver, protected credential/config
delivery, duplex input/progress transport, a product audit adapter, process
supervision, artifact verification, restart/rollback policy, and production
credential storage. The typed runtime messages and adapter boundary do not by
themselves claim production sidecar readiness. Those remaining concerns must
not weaken authentication, bounds, generation, sequencing, cancellation, or
fail-closed behavior.
