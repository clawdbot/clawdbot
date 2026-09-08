---
summary: "Live model discovery, catalog helpers, and provider-owned pricing normalization"
read_when:
  - You are opting a provider into shared live model discovery
  - You need the liveModelDiscovery contract, cache, and failure rules
  - You are normalizing a provider-owned pricing feed
  - You want the narrower single-provider plugin entry helper
title: "Provider model catalogs"
sidebarTitle: "Model catalogs"
---

Catalog reference for provider plugins: shared live model discovery, catalog
helpers, pricing normalization, and the narrower single-provider entry point.
Part of the [Building provider plugins](/plugins/sdk-provider-plugins) guide.

## Live model discovery

If your provider exposes an OpenAI-compatible `/models` API, opt the
single-provider helper into shared discovery:

```typescript
catalog: {
  buildProvider: () => ({
    api: "openai-completions",
    baseUrl: "https://api.acme-ai.com/v1",
    models: [...STATIC_MODELS],
  }),
  buildStaticProvider: () => ({
    api: "openai-completions",
    baseUrl: "https://api.acme-ai.com/v1",
    models: [...STATIC_MODELS],
  }),
  liveModelDiscovery: true,
},
```

`liveModelDiscovery: true` is a public Plugin SDK contract with these
behaviors:

| Area           | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials    | Discovery uses the catalog's resolved provider credential, preferring `discoveryApiKey` when auth supplies one. Secret-reference markers are never sent as tokens. The default request uses `Authorization: Bearer <token>`; use `buildRequestHeaders` for another vendor auth scheme.                                                                                                                                                                                                                                                                                                                            |
| Endpoint       | The default URL is `models` relative to the effective provider `baseUrl`, including an operator override when `allowExplicitBaseUrl` is enabled. Use `endpointPath` for another relative path. Use `endpointUrl: { url, requireBaseUrl }` only for a fixed vendor URL; discovery is skipped unless the effective base URL still equals `requireBaseUrl`, so a custom proxy credential is not sent to the vendor.                                                                                                                                                                                                  |
| Network limits | Fetches use OpenClaw's SSRF guard, one 5-second timeout budget across pagination, a 4 MiB response limit per page, and a 50-page limit. Cross-origin pagination links are rejected; credentials are removed after a cross-origin redirect.                                                                                                                                                                                                                                                                                                                                                                        |
| Cache          | Successful, non-empty catalogs are cached for 60 seconds by provider, endpoint, and resolved credential. Empty or unusable results are not cached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Filtering      | Exact live IDs keep their trusted static metadata. New rows are projected conservatively as text/chat models. Disabled, archived, deprecated, explicitly non-chat, embedding, reranking, moderation, speech, image-only, and video-only rows are excluded. Use `readRows` only to select rows from a nonstandard response envelope; provider-specific model semantics still belong in a custom catalog.                                                                                                                                                                                                           |
| Admission      | Optional. Set `acceptUnknownModel: ({ id, record }) => boolean` when your request shaping is model-version specific, so discovery cannot publish a model you cannot yet build a valid request for. It is called only for IDs your static catalog does not already publish; known IDs bypass it and keep their published metadata. Return `false` to drop the row. Providers that omit it keep the previous behavior unchanged. Prefer comparing the vendor's advertised capabilities against your own contract checks over a hand-maintained model list, and fail closed when the row carries no capability data. |
| Failure        | Live discovery is advisory. Auth, network, timeout, pagination, parsing, empty-catalog, and filtering failures return the provider-owned static seed instead of removing the provider.                                                                                                                                                                                                                                                                                                                                                                                                                            |

Bundled providers set `discoveryMode: "strict"` in their catalog options.
This code option keeps successful empty results empty and reports failed
acquisition through `ProviderCatalogResult.outcomes`, rather than returning
seed models as a successful refresh. HTTP 401/403 produces a catalog-scoped
`auth-rejected` outcome; other acquisition failures produce `unavailable`.
Neither a static catalog nor skipped discovery produces a live outcome.
Each outcome carries the profile selected for the actual request, when one
supplied its credential. Family providers report each sibling independently.

Public metadata requests declare `authentication: "none"` in discovery
options. The prepared request then has no credential or profile identity;
its cache key is independent of the configured inference credential.
The returned provider configuration still retains its inference credential.

External calls that omit `discoveryMode` retain the advisory contract above.
The public Chutes, Hugging Face, KiloCode, and Vercel AI Gateway discovery
functions and builders also retain that default. Their bundled catalog hooks
pass `{ discoveryMode: "strict" }` explicitly; Hugging Face discovery accepts
this options object after its existing timeout argument. The Chutes public
default retains its anonymous retry after HTTP 401; strict calls never retry
without the selected credential.
The strict and advisory paths share the same guarded transport and cache.
Custom live builders can use `runLiveProviderCatalog` at their catalog hook
to convert acquisition errors into outcomes. Keep metadata-feed fallback
separate from account discovery; do not retry a rejected account request
anonymously or substitute seed rows inside a strict builder.

Custom catalog hooks may receive optional `mode` metadata from
`ctx.resolveProviderApiKey()`: `api_key`, `oauth`, or `token`. When present,
it describes that lookup's selected credential. Use it when choosing a vendor
authentication scheme; a separate `resolveProviderAuth()` call may select a
different profile. Omitted mode metadata does not change existing callback behavior.

`ctx.resolveProviderAuth()` may set `preparationFailed: true` when OAuth
preparation exhausted its candidates. Do not treat that flag as absent
configuration or restart resolution of the same profiles. A hook may still
choose another credential source. Its returned provider configuration or
explicit outcome remains authoritative; otherwise the catalog owner reports
the consumed preparation failure with the attempted profile identities.

For a non-Bearer or nonstandard list endpoint, pass options instead of
`true`:

```typescript
liveModelDiscovery: {
  endpointPath: "model-catalog",
  buildRequestHeaders: ({ apiKey, discoveryApiKey }) => ({
    "vendor-version": "2026-01-01",
    "x-api-key": discoveryApiKey ?? apiKey ?? "",
  }),
  readRows: (body) =>
    body && typeof body === "object" &&
    Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : [],
},
```

Do not use `endpointUrl` as an unconditional alternate host. Its
`requireBaseUrl` check is the credential-isolation boundary for providers
whose model-list host differs from their inference host.

If the provider needs custom model semantics rather than the conservative
OpenAI-compatible projection, keep only that projection in the plugin. Pass
it as `projectRows`; the shared runtime still owns guarded fetches,
provider-auth headers, cache admission, and static fallback.

Use `buildLiveModelProviderConfig` when the live API only tells you which
provider-owned static catalog rows are currently available:

```typescript index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLiveModelProviderConfig,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";

const STATIC_MODELS = [
  {
    id: "acme-large",
    name: "Acme Large",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "acme-small",
    name: "Acme Small",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
] as const;

async function buildAcmeLiveProvider(params: {
  apiKey: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
}) {
  return await buildLiveModelProviderConfig({
    providerId: "acme-ai",
    endpoint: "https://api.acme-ai.com/v1/models",
    providerConfig: {
      baseUrl: "https://api.acme-ai.com/v1",
      api: "openai-completions",
    },
    models: STATIC_MODELS,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    ttlMs: 60_000,
    auditContext: "acme-ai-model-discovery",
    projectRows: (rows, fallback) =>
      rows.flatMap((row) => {
        const model = projectAcmeModel(row, fallback);
        return model ? [model] : [];
      }),
  });
}

export default definePluginEntry({
  id: "acme-ai",
  name: "Acme AI",
  register(api) {
    api.registerProvider({
      id: "acme-ai",
      label: "Acme AI",
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderAuth("acme-ai");
          const apiKey = auth.apiKey ?? ctx.resolveProviderApiKey("acme-ai").apiKey;
          if (!apiKey) return null;
          return {
            provider: await buildAcmeLiveProvider({
              apiKey,
              discoveryApiKey: auth.discoveryApiKey,
            }),
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: {
            baseUrl: "https://api.acme-ai.com/v1",
            api: "openai-completions",
            models: [...STATIC_MODELS],
          },
        }),
      },
    });
  },
});
```

`run` should stay auth-gated and return `null` when no usable credential is
available. Keep an offline `staticRun` or static fallback so setup, docs,
tests, and picker surfaces do not depend on live network access. Use a TTL
appropriate for model-list freshness, avoid request-time filesystem polling,
and pass a provider-specific `readRows` / `readModelId` only when the
upstream response is not an OpenAI-compatible `{ data: [{ id, object }] }`
shape.

For a separate authoritative metadata feed, the same
`provider-catalog-live-runtime` subpath exposes `ProviderCatalogSnapshot`:
each entry pairs a runtime model with its lifecycle status.
`projectUpstreamProviderCatalogSnapshot` rebuilds that snapshot from a
trusted seed and accepted upstream rows, dropping withdrawn upstream-only
models. `projectProviderCatalogSnapshotRows` intersects advertised IDs with
active snapshot entries, deduplicating in endpoint order;
`listProviderCatalogSnapshotEntries` projects the same lifecycle facts for
catalog consumers. Keep seed lifecycle policy and model-specific decoration
in the owning plugin. Derive static fallback eligibility after refreshing
metadata so the first failed or fully filtered discovery uses current status.
Public metadata never establishes account entitlement or expands the
credential scope of discovery.

Official plugins use the private, pure
`openclaw/plugin-sdk/model-catalog-pricing` runtime subpath. It exposes
`normalizeModelPricingCatalog(rows, normalizePricing, options?)` for
provider-owned pricing feeds. It returns a map of complete costs: absent
prices are omitted, while malformed declared prices, invalid or duplicate
model IDs, and a feed with no usable prices return `undefined`. Supply the
provider's unit conversion. Options can select `readModelId(model)` (default
`model.id`), `readPricing(model)` (default `model.pricing`), and
`isSupportedPricing(rawPricing)` (default `true`). Declared prices are
normalized and validated before unsupported schedules are omitted; duplicate
IDs are rejected even on unpriced or unsupported rows. Non-token domains
can return `undefined` from `readPricing`. No auth, discovery, or runtime
loader is imported.

DeepInfra's `pricing-api.ts` uses these selectors for its native array and
`model_name` identities. Release plugins using the options contract (including
DeepInfra and Venice) with a matching host, and coordinate their plugin API
and minimum-host floors at release time. The private subpath is not an
independently versioned third-party compatibility API.

This subpath also exposes `normalizeOpenRouterModelPricing(pricing)` for
native OpenRouter pricing objects. It converts per-token rates and static
prompt-length overrides into a complete per-million cost schedule, without
network access or prices from another source. Overrides apply strictly above
`min_prompt_tokens`, counting uncached input, cache reads, and cache writes.
Matching entries apply in source order: later entries win per price key,
including at equal thresholds; omitted keys inherit the native base or an
earlier matching entry. Cache rates absent from the base default to zero.
Invalid effective token rates return `undefined`. Entries with time-based or
unknown conditions are skipped; other known charge dimensions are ignored.

When `ctx.providerIds` is present, it contains the normalized provider
identities selected for that catalog owner. Return `null` before resolving
credentials or making network requests when the hook serves none of them;
OpenClaw also filters returned identities to that scope. An absent scope
means the caller requested the full catalog.

If the upstream provider uses different control tokens than OpenClaw, add a
small bidirectional text transform instead of replacing the stream path:

```typescript
api.registerTextTransforms({
  input: [
    { from: /red basket/g, to: "blue basket" },
    { from: /paper ticket/g, to: "digital ticket" },
    { from: /left shelf/g, to: "right shelf" },
  ],
  output: [
    { from: /blue basket/g, to: "red basket" },
    { from: /digital ticket/g, to: "paper ticket" },
    { from: /right shelf/g, to: "left shelf" },
  ],
});
```

`input` rewrites the final system prompt and text message content before
transport. `output` rewrites assistant text deltas and final text before
OpenClaw parses its own control markers or channel delivery.

For bundled providers that only register one text provider with API-key
auth plus a single catalog-backed runtime, prefer the narrower
`defineSingleProviderPluginEntry(...)` helper:

```typescript
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";

export default defineSingleProviderPluginEntry({
  id: "acme-ai",
  name: "Acme AI",
  description: "Acme AI model provider",
  provider: {
    label: "Acme AI",
    docsPath: "/providers/acme-ai",
    auth: [
      {
        methodId: "api-key",
        label: "Acme AI API key",
        hint: "API key from your Acme AI dashboard",
        optionKey: "acmeAiApiKey",
        flagName: "--acme-ai-api-key",
        envVar: "ACME_AI_API_KEY",
        promptMessage: "Enter your Acme AI API key",
        defaultModel: "acme-ai/acme-large",
      },
    ],
    catalog: {
      buildProvider: () => ({
        api: "openai-completions",
        baseUrl: "https://api.acme-ai.com/v1",
        models: [{ id: "acme-large", name: "Acme Large" }],
      }),
      buildStaticProvider: () => ({
        api: "openai-completions",
        baseUrl: "https://api.acme-ai.com/v1",
        models: [{ id: "acme-large", name: "Acme Large" }],
      }),
    },
  },
});
```

`buildProvider` is the live catalog path used when OpenClaw can resolve real
provider auth. It may perform provider-specific discovery. Use
`buildStaticProvider` only for offline rows that are safe to show before auth
is configured; it must not require credentials or make network requests.
OpenClaw's `models list --all` display currently executes static catalogs
only for bundled provider plugins, with an empty config, empty env, and no
agent/workspace paths.

If your auth flow also needs to patch `models.providers.*`, aliases, and
the agent default model during onboarding, use the preset helpers from
`openclaw/plugin-sdk/provider-onboard`. The narrowest helpers are
`createDefaultModelPresetAppliers(...)`,
`createDefaultModelsPresetAppliers(...)`, and
`createModelCatalogPresetAppliers(...)`.

When a provider's native endpoint supports streamed usage blocks on the
normal `openai-completions` transport, prefer the shared catalog helpers in
`openclaw/plugin-sdk/provider-catalog-shared` instead of hardcoding
provider-id checks. `supportsNativeStreamingUsageCompat(...)` and
`applyProviderNativeStreamingUsageCompat(...)` detect support from the
endpoint capability map, so native Moonshot/DashScope-style endpoints still
opt in even when a plugin is using a custom provider id.

The live discovery examples above cover `/models`-style provider APIs. Keep
that discovery inside `catalog.run`, gated on usable auth, and keep
`staticRun` network-free for offline catalog generation.

Official provider plugins that share credentials can use
`resolveFirstProviderCatalogAuth(ctx.resolveProviderApiKey, providerIds)` from
the private runtime `openclaw/plugin-sdk/provider-catalog-shared` subpath.
Keep provider precedence in the caller's ordered IDs. The helper stops at
the first result with an `apiKey` or `discoveryApiKey` and returns that whole
result, preserving its profile and auth mode. An unresolved SecretRef marker
takes precedence over another provider's live key; fields are never mixed
across accounts. It returns `undefined` when no provider has auth and
propagates lookup failures. Official plugin releases using this host export
must require a host version that provides it in their `compat.pluginApi`.
