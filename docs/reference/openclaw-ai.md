---
summary: "The @openclaw/ai npm package: reusable model transports, isolated runtimes, and host policy ports"
title: "@openclaw/ai package"
read_when:
  - You want to reuse OpenClaw's model transports in another application
  - You are changing packages/ai or the AI transport host ports
  - You are reviewing what the openclaw release publishes to npm besides the root package
---

`@openclaw/ai` is the publishable library form of OpenClaw's model execution
layer: provider-neutral message/tool/stream contracts, validation, diagnostics,
event streams, an isolated runtime registry, and lazy adapters for the eight
built-in API families (Anthropic Messages, OpenAI Completions, OpenAI
Responses, Azure OpenAI Responses, ChatGPT/Codex Responses, Google Generative
AI, Google Vertex, Mistral Conversations).

It publishes alongside the root `openclaw` package on every release, pinned to
the same version. Its exact-pinned direct dependencies resolve at install time;
the package ships no npm lockfile. Installing `openclaw` installs the matching
`@openclaw/ai` automatically, and library consumers can depend on it directly
without any OpenClaw application code.

## Quick start

```js
import { createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";

const runtime = createLlmRuntime();
registerBuiltInApiProviders(runtime.registry);

const stream = runtime.streamSimple(model, { messages }, { apiKey });
for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
const result = await stream.result();
```

A runnable version lives in the repository at `examples/ai-chat`.

## Design contract

- **Instance-scoped by default.** Importing the package registers nothing
  globally. `createApiRegistry()` / `createLlmRuntime()` return isolated
  instances; `registerBuiltInApiProviders(registry)` opts one registry into the
  built-in transports. Provider SDK modules load lazily on first use.
- **Host policy is injected, not bundled.** Request fetch guarding (for
  example SSRF policy), secret redaction of tool-result replay text, OpenAI
  strict-tool defaults, diagnostics logging, and typed transport-event
  observation are `AiTransportHost` ports configured with
  `configureAiTransportHost`. `buildModelFetchWithBlockingDispatchGuard` owns
  the fail-closed `beforeFetchDispatch` callback for every physical fetch hop
  after SSRF and DNS preflight but before network dispatch. Throwing prevents
  that hop, and hosts that cannot install the named guard fail closed.
  `buildModelFetchWithDispatchAttestation` is the separate optional port for
  non-blocking per-hop observation. Both named ports require a structured
  `AiModelFetchResult` with `dispatch_attested` provenance; the legacy
  `buildModelFetch` port is callable-only and cannot attest dispatch.
  `connectModelWebSocket` is the host-owned guarded WebSocket port. A returned
  resource attests complete upgrade-header observation and callback-based send
  admission; `dispose()` owns the socket, proxy/TLS connection, and local
  provider-service lease. Its abort signal applies only while opening.
  Node and Bun applications can provide this port for guarded OpenClaw routing;
  standalone runtimes use the packaged WebSocket client. Browser runtimes may
  use their ambient WebSocket implementation. An installed host port that
  returns no resource declines the route and never falls through to an
  unguarded client.
  Within those ports, `observeFetchDispatch` runs once per physical hop,
  including redirects. `onFetchDispatch` remains isolated observational
  accounting, runs once per provider-request fetch invocation, and cannot alter
  provider behavior. One attempt means one dispatched provider request,
  distinct from its physical fetch hops;
  connection setup and prewarm do not count as attempts. A zero-submission fact
  means the route phase ended before the dispatch boundary. Exact zero requires
  a structured `AiModelFetchResult` with `dispatch_attested` provenance; a
  legacy bare fetch without callback evidence remains unavailable. Transport
  fallback stages a concrete target until a matching attempt or zero-submission
  phase consumes it. A server-side serving-model fallback is in-stream
  submission evidence and does not rewrite the requested provider/model/API
  identity.
  Scoped coverage can mark only provider-fallback identity lower-bound when
  terminal metadata is unavailable; dispatched attempt and event totals remain
  exact. The library default observer is inert; OpenClaw installs its collector
  in its stream facade. Provider coverage depends on which adapters emit these
  facts.
- **One event-stream identity.** `@openclaw/ai/event-stream` is the canonical
  `EventStream` constructor shared by OpenClaw core, agent-core, and external
  consumers.
- **`internal/*` subpaths are not API.** They exist for the OpenClaw
  application itself and carry no semver guarantee.
- Provider ids, credentials, model catalogs, retries, and failover remain
  application concerns. OpenClaw layers those around this package; a library
  consumer supplies a `Model` object and options directly.

## Subpath exports

| Subpath          | Contents                                                                       |
| ---------------- | ------------------------------------------------------------------------------ |
| `.`              | Contracts, `createApiRegistry`, `createLlmRuntime`, `configureAiTransportHost` |
| `./providers`    | `registerBuiltInApiProviders`, `resetApiProviders`                             |
| `./types`        | Model/message/tool/stream types                                                |
| `./validation`   | Tool argument validation                                                       |
| `./diagnostics`  | Diagnostics contracts                                                          |
| `./event-stream` | Shared `EventStream` implementation                                            |
| `./internal/*`   | OpenClaw-internal, no semver guarantee                                         |
