# `@openclaw/ai`

Reusable model API contracts, provider adapters, and streaming primitives from
OpenClaw. The package supports isolated runtime instances; importing it does not
register providers globally.

```ts
import { createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";

const runtime = createLlmRuntime();
registerBuiltInApiProviders(runtime.registry);
```

Provider-neutral contracts, validation, diagnostics, and event streams are
available from the package root and focused subpaths such as
`@openclaw/ai/event-stream`, `@openclaw/ai/transports`, and
`@openclaw/ai/validation`. No second OpenClaw runtime package is required.

Provider ids, credentials, model catalogs, retries, and failover remain
application concerns. OpenClaw supplies those policies around this package.
Host policy (request fetch guarding, secret redaction, strict-tool defaults,
provider plugin hooks, diagnostics logging, and typed transport-event
observation) can be injected with `configureAiTransportHost`; the defaults are
inert. `buildModelFetchWithBlockingDispatchGuard` owns the fail-closed
`beforeFetchDispatch` callback invoked for every physical fetch hop after SSRF
and DNS preflight but before network dispatch; throwing prevents that hop, and
a host that cannot install the named guard fails closed.
`buildModelFetchWithDispatchAttestation` is the separate optional port for
non-blocking per-hop observation. Both named ports require a structured
`AiModelFetchResult` with `dispatch_attested` provenance; legacy
`buildModelFetch` remains callable-only and cannot attest dispatch.
`connectModelWebSocket` is the host-owned guarded WebSocket port. A returned
resource attests complete upgrade-header observation and callback-based send
admission; `dispose()` owns the socket, proxy/TLS connection, and local
provider-service lease. Its abort signal applies only while opening.
Node and Bun applications can provide this port for guarded OpenClaw routing;
standalone runtimes use the packaged WebSocket client. Browser runtimes may use
their ambient WebSocket implementation. An installed host port that returns no
resource declines the route and never falls through to an unguarded client.
Within those ports, `observeFetchDispatch` runs once per physical hop, including
redirects. `onFetchDispatch` remains isolated observational accounting, runs
once per provider-request fetch invocation, and cannot change provider
behavior. A transport attempt is one dispatched provider request, distinct from
its physical fetch hops. Connection setup and prewarm are separate facts.
Transport fallback stages a concrete target until a matching attempt or
zero-submission phase consumes it. Server-side provider fallback records an
in-stream serving-model transition without rewriting the requested
provider/model/API identity. Failed or aborted calls that end before the
dispatch boundary use an explicit zero-submission fact instead of an invented
attempt. Exact zero requires a structured `AiModelFetchResult` with
`dispatch_attested` provenance; a legacy bare fetch without callback evidence
remains unavailable. When a physical attempt is known but terminal provider
fallback metadata is unavailable, scoped coverage lowers only the derived
provider-fallback total and serving-model identity; attempt and event counts
remain exact.

The explicit `@openclaw/ai/internal/anthropic`, `openai`, `retry-after`,
`runtime`, and `shared` subpaths exist for the OpenClaw application itself.
They carry no semver guarantee and can change or disappear in any release; do
not depend on them outside OpenClaw.
