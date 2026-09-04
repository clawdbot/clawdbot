# Native Watch WebRTC

This module exposes a small C ABI over pinned `str0m` 0.23.1. It does not open
sockets: `WatchRealtimeTransport` owns UDP through Network.framework, and
`WatchRealtimeAudioIO` owns capture, native Opus conversion and playback.
The Gateway owns provider credentials, tools and transcripts through
`gateway-control-v1`; this module has no provider data channel.

## Build prerequisites

Install Xcode with the watchOS SDK and select it with `DEVELOPER_DIR` or the
normal Xcode command-line-tool setting. The device and simulator slices below
were compiled with the watchOS 27 SDK. The application deployment target remains
watchOS 11; older devices use the `arm64_32` slice. The newer `arm64` Watch ABI
starts at watchOS 26.

Install Rust with the official [rustup installer](https://rustup.rs/), then install
the exact toolchain used by the module:

```sh
rustup toolchain install nightly-2026-08-31 --profile minimal --component rust-src
```

The pinned nightly is required because Rust classifies `arm64_32` Watch and Intel
Watch Simulator as Tier 3; their standard libraries must be built from source.
`build.sh` uses the same pinned compiler for every slice and never installs or
changes a global toolchain. It honors the standard `CARGO_HOME`, `RUSTUP_HOME`
and `DEVELOPER_DIR` variables, so task-local installations work too.

Run from the repository root; put output in a build directory, not source control:

```sh
apps/shared/OpenClawWatchRTC/build.sh watchos /tmp/watch-rtc-device arm64 arm64_32
apps/shared/OpenClawWatchRTC/build.sh watchsimulator /tmp/watch-rtc-simulator arm64 x86_64
```

Each command writes `libopenclaw_watch_rtc.a` and its Cargo build cache to the
chosen output directory. A native macOS proof can use `macosx` with `arm64` or
`x86_64`; macOS execution does not verify Watch radio or background behavior.

| SDK | Xcode architecture | Rust target |
| --- | --- | --- |
| watchos | arm64 | aarch64-apple-watchos |
| watchos | arm64_32 | arm64_32-apple-watchos |
| watchsimulator | arm64 | aarch64-apple-watchos-sim |
| watchsimulator | x86_64 | x86_64-apple-watchos-sim |

Add `include/` to the Swift import/header search path and the selected output
directory to the library search path. Link `libopenclaw_watch_rtc.a`, Security,
Network and AVFAudio. Device and simulator outputs must stay in separate
directories; they are different platforms even when both contain `arm64`.

The `rust-crypto` feature still uses AWS-LC for DTLS and certificate generation.
On `arm64_32`, `AWS_LC_SYS_NO_ASM=1` selects its supported portable implementation
and Release optimization level 2 avoids incompatible AArch64/ILP32 limb code.
The script uses the documented CC builder; it does not patch dependencies or
suppress compiler errors. Other slices retain assembly. Cargo.lock fixes all
transitive versions.

## Engine regression tests

Run the pinned native engine tests without opening network sockets:

```sh
cargo +nightly-2026-08-31 test --locked --manifest-path apps/shared/OpenClawWatchRTC/Cargo.toml --lib -- --test-threads=1
```

The iOS CI test phase runs these tests too. They exchange authenticated Opus
between real ICE/DTLS engines, model NAT64 packet translation, and check candidate
admission, exact remote addresses and the combined endpoint limit. Audio-loss
cases drop or delay a packet before a sender pause. This does not prove the
system resolver, Watch radio, microphone or speaker path.

## Ownership and limits

Each engine supplies fresh ICE credentials from the operating system's
cryptographic RNG instead of the pinned library's non-cryptographic default.
On watchOS this uses CommonCrypto; entropy failure prevents engine creation.

Every native RTC mutation must be followed by polling until the next timeout.
`WatchRealtimeTransport` enforces this on one serial queue. C byte pointers are
borrowed until the next bridge call and are copied before crossing the queue.
The initial offer has no local candidates and requires an ICE-lite answer with
UDP candidates. After accepting that answer, the transport resolves IPv4 literals
through the system resolver on a utility queue. One bounded plan gives ICE and
Network.framework the same returned endpoints, including synthesized IPv6 routes
on DNS64/NAT64 networks. A failed lookup cannot reopen its original address through
a later ICE check; usable siblings remain eligible. Cancellation does not wait for
a blocked resolver and late results cannot restart a retired transport.

The transport opens outbound flows and registers their actual Network.framework
ready addresses with ICE before sending checks. It does not assume a requested
local port was honored or disguise an IPv6 socket as an IPv4 candidate.
The provider learns the local candidates through authenticated ICE checks; no
second SDP exchange or trickle channel is needed for this ICE-lite flow.

Candidate discovery is bounded by the pinned ICE engine's 100-pair budget.
Unsupported answers and oversized candidate sets fail visibly rather than being
silently truncated. Only a pending ICE check may wait for a flow to become ready;
media requires a ready route. Cancellation closes the same admission lock used
for native mutations and network sends. The transport does not add an external
STUN service, TURN relay, TCP media fallback or BSD socket path.

Start and asynchronously activate the duplex audio session before opening any
low-level Watch connection. Watch audio uses `playAndRecord`, `voiceChat` and the
default route-sharing policy. Long-form routing is playback-only. The hardware
capture rate is read after activation and resampled to mono 48 kHz; outgoing Opus
frames are 20 ms. Watch input taps can deliver larger batches.

Incoming Opus uses a one-frame reorder window: a missing packet cannot hold later
speech until the sender resumes. Packets arriving after newer speech are dropped,
not replayed; bounded playback favors low latency over waiting for reordering.

Await `WatchRealtimeMediaSession.stop()` before starting a replacement. The
process-global audio lease stays owned until an uncancellable activation callback
has drained. Permission denial, interruption and media-service reset end visibly.
Network reconnection belongs to the call controller, not the media queues.

Watch Simulator permits low-level networking that a device may reject. Native
provider interoperability and cross-compilation do not establish speaker routing,
wrist-down operation, Wi-Fi/cellular handoff, battery life or long-call reliability.
See [Apple TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos).

Third-party acknowledgements are in `apps/ios/Resources/Licenses/str0m.txt`, shared
by the phone and Watch bundles. Dependency or toolchain updates require auditing
both Cargo package notices and the Rust standard-library copyright notices.
