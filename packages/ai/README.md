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
inert. A transport attempt is one provider request dispatched through its
transport. Connection setup
and prewarm are separate facts. Transport fallback stages a concrete target
until a matching attempt or zero-submission phase consumes it. Server-side
provider fallback records an in-stream serving-model transition without
rewriting the requested provider/model/API identity. Failed or aborted calls
that end before dispatch use an explicit zero-submission fact instead of an
invented attempt. When a physical attempt is known but terminal provider
fallback metadata is unavailable, scoped coverage lowers only the derived
provider-fallback total and serving-model identity; attempt and event counts
remain exact.

The explicit `@openclaw/ai/internal/anthropic`, `openai`, `retry-after`,
`runtime`, and `shared` subpaths exist for the OpenClaw application itself.
They carry no semver guarantee and can change or disappear in any release; do
not depend on them outside OpenClaw.
