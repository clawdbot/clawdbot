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
Features are intersected. Frame, in-flight, and deadline values use the lower
valid offer. Unknown features remain disabled.

The offer and acceptance are application payloads carried in authenticated
frames. Higher layers must complete negotiation before accepting credentials,
configuration, capability registration, or invocation traffic.

## Cross-language vector

[`node-sidecar-protocol-v1.json`](../../test/fixtures/node-sidecar-protocol-v1.json)
contains a test-only session key, payload, and exact encoded frame. Rust tests
both reproduce and decode it. Every non-Rust adapter must consume the same
vector before it can be selected as a runtime.

## Not yet implemented

This slice deliberately excludes the typed supervisor/runtime messages,
handshake state machine, node-runtime bridge, native capability dispatch,
product audit adapter, process supervision, restart/rollback policy, and
production credential storage. Those concerns build on this framing contract;
they must not weaken its authentication, bounds, generation, sequencing, or
fail-closed behavior.
