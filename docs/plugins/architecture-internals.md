---
summary: "Plugin architecture internals: load pipeline, registry, runtime hooks, HTTP routes, and reference tables"
read_when:
  - Implementing provider runtime hooks, channel lifecycle, or package packs
  - Debugging plugin load order or registry state
  - Adding a new plugin capability or context engine plugin
title: "Plugin architecture internals"
---

For the public capability model, plugin shapes, and ownership/execution
contracts, see [Plugin architecture](/plugins/architecture). This page is the
reference for the internal mechanics: load pipeline, registry, runtime hooks,
Gateway HTTP routes, import paths, and schema tables.

## Load pipeline

At startup, OpenClaw does roughly this:

1. discover candidate plugin roots
2. read native or compatible bundle manifests and package metadata
3. reject unsafe candidates
4. normalize plugin config (`plugins.enabled`, `allow`, `deny`, `entries`,
   `slots`, `load.paths`)
5. decide enablement for each candidate
6. load enabled native modules: built bundled modules use a native loader;
   unbuilt native plugins use jiti
7. call native `register(api)` hooks and collect registrations into the plugin registry
8. expose the registry to commands/runtime surfaces

<Note>
`activate` is a legacy alias for `register` — the loader resolves whichever is present (`def.register ?? def.activate`) and calls it at the same point. All bundled plugins use `register`; prefer `register` for new plugins.
</Note>

The safety gates happen **before** runtime execution. Candidates are blocked
when the entry escapes the plugin root, the path is world-writable, or path
ownership looks suspicious for non-bundled plugins.

### Manifest-first behavior

The manifest is the control-plane source of truth. OpenClaw uses it to:

- identify the plugin
- discover declared channels/skills/config schema or bundle capabilities
- validate `plugins.entries.<id>.config`
- augment Control UI labels/placeholders
- show install/catalog metadata
- preserve cheap activation and setup descriptors without loading plugin runtime

For native plugins, the runtime module is the data-plane part. It registers
actual behavior such as hooks, tools, commands, or provider flows.

Optional manifest `activation` and `setup` blocks stay on the control plane.
They are metadata-only descriptors for activation planning and setup discovery;
they do not replace runtime registration, `register(...)`, or `setupEntry`.
The first live activation consumers now use manifest command, channel, and provider hints
to narrow plugin loading before broader registry materialization:

- CLI loading narrows to plugins that own the requested primary command
- channel setup/plugin resolution narrows to plugins that own the requested
  channel id
- explicit provider setup/runtime resolution narrows to plugins that own the
  requested provider id
- Gateway startup planning uses `activation.onStartup` for explicit startup
  imports and startup opt-outs; every plugin should declare it as OpenClaw
  moves away from implicit startup imports, while plugins without static
  capability metadata and without `activation.onStartup` still use the
  deprecated implicit startup sidecar fallback for compatibility

The activation planner exposes both an ids-only API for existing callers and a
plan API for new diagnostics. Plan entries report why a plugin was selected,
separating explicit `activation.*` planner hints from manifest ownership
fallback such as `providers`, `channels`, `commandAliases`, `setup.providers`,
`contracts.tools`, and hooks. That reason split is the compatibility boundary:
existing plugin metadata keeps working, while new code can detect broad hints
or fallback behavior without changing runtime loading semantics.

Setup discovery now prefers descriptor-owned ids such as `setup.providers` and
`setup.cliBackends` to narrow candidate plugins before it falls back to
`setup-api` for plugins that still need setup-time runtime hooks. Provider
setup lists use manifest `providerAuthChoices`, descriptor-derived setup
choices, and install-catalog metadata without loading provider runtime. Explicit
`setup.requiresRuntime: false` is a descriptor-only cutoff; omitted
`requiresRuntime` keeps the legacy setup-api fallback for compatibility. If more
than one discovered plugin claims the same normalized setup provider or CLI
backend id, setup lookup refuses the ambiguous owner instead of relying on
discovery order. When setup runtime does execute, registry diagnostics report
drift between `setup.providers` / `setup.cliBackends` and the providers or CLI
backends registered by setup-api without blocking legacy plugins.

### Plugin cache boundary

OpenClaw does not cache plugin discovery results or direct manifest registry
data behind wall-clock windows. Installs, manifest edits, and load-path changes
must become visible on the next explicit metadata read or snapshot rebuild.
The manifest file parser may keep a bounded file-signature cache keyed by the
opened manifest path, inode, size, and timestamps; that cache only avoids
re-parsing unchanged bytes and must not cache discovery, registry, owner, or
policy answers.

The safe metadata fast path is explicit object ownership, not a hidden cache.
Gateway startup hot paths should pass the current `PluginMetadataSnapshot`, the
derived `PluginLookUpTable`, or an explicit manifest registry through the call
chain. Config validation, startup auto-enable, plugin bootstrap, and provider
selection can reuse those objects while they represent the current config and
plugin inventory. Setup lookup still reconstructs manifest metadata on demand
unless the specific setup path receives an explicit manifest registry; keep that
as a cold-path fallback rather than adding hidden lookup caches. When the input
changes, rebuild and replace the snapshot instead of mutating it or keeping
historical copies.
Views over the active plugin registry and bundled channel bootstrap helpers
should be recomputed from the current registry/root. Short-lived maps are fine
inside one call to dedupe work or guard reentry; they must not become process
metadata caches.

For plugin loading, the persistent cache layer is runtime loading. It may reuse
loader state when code or installed artifacts are actually loaded, such as:

- `PluginLoaderCacheState` and compatible active runtime registries
- jiti/module caches and public-surface loader caches used to avoid importing
  the same runtime surface repeatedly
- runtime dependency mirrors and filesystem caches for installed plugin
  artifacts
- short-lived per-call maps for path normalization or duplicate resolution

Those caches are data-plane implementation details. They must not answer
control-plane questions such as "which plugin owns this provider?" unless the
caller deliberately asked for runtime loading.

Do not add persistent or wall-clock caches for:

- discovery results
- direct manifest registries
- manifest registries reconstructed from the installed plugin index
- provider owner lookup, model suppression, provider policy, or public-artifact
  metadata
- any other manifest-derived answer where a changed manifest, installed index,
  or load path should be visible on the next metadata read

Callers that rebuild manifest metadata from the persisted installed plugin
index reconstruct that registry on demand. The installed index is durable
source-plane state; it is not a hidden in-process metadata cache.

## Registry model

Loaded plugins do not directly mutate random core globals. They register into a
central plugin registry.

The registry tracks:

- plugin records (identity, source, origin, status, diagnostics)
- tools
- legacy hooks and typed hooks
- channels
- providers
- gateway RPC handlers
- HTTP routes
- CLI registrars
- background services
- plugin-owned commands

Core features then read from that registry instead of talking to plugin modules
directly. This keeps loading one-way:

- plugin module -> registry registration
- core runtime -> registry consumption

That separation matters for maintainability. It means most core surfaces only
need one integration point: "read the registry", not "special-case every plugin
module".

## Conversation binding callbacks

Plugins that bind a conversation can react when an approval is resolved.

Use `api.onConversationBindingResolved(...)` to receive a callback after a bind
request is approved or denied:

```ts
export default {
  id: "my-plugin",
  register(api) {
    api.onConversationBindingResolved(async (event) => {
      if (event.status === "approved") {
        // A binding now exists for this plugin + conversation.
        console.log(event.binding?.conversationId);
        return;
      }

      // The request was denied; clear any local pending state.
      console.log(event.request.conversation.conversationId);
    });
  },
};
```

Callback payload fields:

- `status`: `"approved"` or `"denied"`
- `decision`: `"allow-once"`, `"allow-always"`, or `"deny"`
- `binding`: the resolved binding for approved requests
- `request`: the original request summary, detach hint, sender id, and
  conversation metadata

This callback is notification-only. It does not change who is allowed to bind a
conversation, and it runs after core approval handling finishes.

## Provider runtime hooks

Provider plugins have three layers:

- **Manifest metadata** for cheap pre-runtime lookup:
  `setup.providers[].envVars`, deprecated compatibility `providerAuthEnvVars`,
  `providerAuthAliases`, `providerAuthChoices`, and `channelEnvVars`.
- **Config-time hooks**: `catalog` (legacy `discovery`) plus
  `applyConfigDefaults`.
- **Runtime hooks**: 40+ optional hooks covering auth, model resolution,
  stream wrapping, thinking levels, replay policy, and usage endpoints. See
  the full list under [Hook order and usage](#hook-order-and-usage).

OpenClaw still owns the generic agent loop, failover, transcript handling, and
tool policy. These hooks are the extension surface for provider-specific
behavior without needing a whole custom inference transport.

Use manifest `setup.providers[].envVars` when the provider has env-based
credentials that generic auth/status/model-picker paths should see without
loading plugin runtime. Deprecated `providerAuthEnvVars` is still read by the
compatibility adapter during the deprecation window, and non-bundled plugins
that use it receive a manifest diagnostic. Use manifest `providerAuthAliases`
when one provider id should reuse another provider id's env vars, auth profiles,
config-backed auth, and API-key onboarding choice. Use manifest
`providerAuthChoices` when onboarding/auth-choice CLI surfaces should know the
provider's choice id, group labels, and simple one-flag auth wiring without
loading provider runtime. Keep provider runtime
`envVars` for operator-facing hints such as onboarding labels or OAuth
client-id/client-secret setup vars.

Use manifest `channelEnvVars` when a channel has env-driven auth or setup that
generic shell-env fallback, config/status checks, or setup prompts should see
without loading channel runtime.

### Hook order and usage

For model/provider plugins, OpenClaw calls hooks in this rough order.
The "When to use" column is the quick decision guide.
Compatibility-only provider fields that OpenClaw no longer calls, such as
`ProviderPlugin.capabilities` and `suppressBuiltInModel`, are intentionally not
listed here.

| #   | Hook                              | What it does                                                                                                   | When to use                                                                                                                                   |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `catalog`                         | Publish provider config into `models.providers` during `models.json` generation                                | Provider owns a catalog or base URL defaults                                                                                                  |
| 2   | `applyConfigDefaults`             | Apply provider-owned global config defaults during config materialization                                      | Defaults depend on auth mode, env, or provider model-family semantics                                                                         |
| --  | _(built-in model lookup)_         | OpenClaw tries the normal registry/catalog path first                                                          | _(not a plugin hook)_                                                                                                                         |
| 3   | `normalizeModelId`                | Normalize legacy or preview model-id aliases before lookup                                                     | Provider owns alias cleanup before canonical model resolution                                                                                 |
| 4   | `normalizeTransport`              | Normalize provider-family `api` / `baseUrl` before generic model assembly                                      | Provider owns transport cleanup for custom provider ids in the same transport family                                                          |
| 5   | `normalizeConfig`                 | Normalize `models.providers.<id>` before runtime/provider resolution                                           | Provider needs config cleanup that should live with the plugin; bundled Google-family helpers also backstop supported Google config entries   |
| 6   | `applyNativeStreamingUsageCompat` | Apply native streaming-usage compat rewrites to config providers                                               | Provider needs endpoint-driven native streaming usage metadata fixes                                                                          |
| 7   | `resolveConfigApiKey`             | Resolve env-marker auth for config providers before runtime auth loading                                       | Provider has provider-owned env-marker API-key resolution; `amazon-bedrock` also has a built-in AWS env-marker resolver here                  |
| 8   | `resolveSyntheticAuth`            | Surface local/self-hosted or config-backed auth without persisting plaintext                                   | Provider can operate with a synthetic/local credential marker                                                                                 |
| 9   | `resolveExternalAuthProfiles`     | Overlay provider-owned external auth profiles; default `persistence` is `runtime-only` for CLI/app-owned creds | Provider reuses external auth credentials without persisting copied refresh tokens; declare `contracts.externalAuthProviders` in the manifest |
| 10  | `shouldDeferSyntheticProfileAuth` | Lower stored synthetic profile placeholders behind env/config-backed auth                                      | Provider stores synthetic placeholder profiles that should not win precedence                                                                 |
| 11  | `resolveDynamicModel`             | Sync fallback for provider-owned model ids not in the local registry yet                                       | Provider accepts arbitrary upstream model ids                                                                                                 |
| 12  | `prepareDynamicModel`             | Async warm-up, then `resolveDynamicModel` runs again                                                           | Provider needs network metadata before resolving unknown ids                                                                                  |
| 13  | `normalizeResolvedModel`          | Final rewrite before the embedded runner uses the resolved model                                               | Provider needs transport rewrites but still uses a core transport                                                                             |
| 14  | `contributeResolvedModelCompat`   | Contribute compat flags for vendor models behind another compatible transport                                  | Provider recognizes its own models on proxy transports without taking over the provider                                                       |
| 15  | `normalizeToolSchemas`            | Normalize tool schemas before the embedded runner sees them                                                    | Provider needs transport-family schema cleanup                                                                                                |
| 16  | `inspectToolSchemas`              | Surface provider-owned schema diagnostics after normalization                                                  | Provider wants keyword warnings without teaching core provider-specific rules                                                                 |
| 17  | `resolveReasoningOutputMode`      | Select native vs tagged reasoning-output contract                                                              | Provider needs tagged reasoning/final output instead of native fields                                                                         |
| 18  | `prepareExtraParams`              | Request-param normalization before generic stream option wrappers                                              | Provider needs default request params or per-provider param cleanup                                                                           |
| 19  | `createStreamFn`                  | Fully replace the normal stream path with a custom transport                                                   | Provider needs a custom wire protocol, not just a wrapper                                                                                     |
| 20  | `wrapStreamFn`                    | Stream wrapper after generic wrappers are applied                                                              | Provider needs request headers/body/model compat wrappers without a custom transport                                                          |
| 21  | `resolveTransportTurnState`       | Attach native per-turn transport headers or metadata                                                           | Provider wants generic transports to send provider-native turn identity                                                                       |
| 22  | `resolveWebSocketSessionPolicy`   | Attach native WebSocket headers or session cool-down policy                                                    | Provider wants generic WS transports to tune session headers or fallback policy                                                               |
| 23  | `formatApiKey`                    | Auth-profile formatter: stored profile becomes the runtime `apiKey` string                                     | Provider stores extra auth metadata and needs a custom runtime token shape                                                                    |
| 24  | `refreshOAuth`                    | OAuth refresh override for custom refresh endpoints or refresh-failure policy                                  | Provider does not fit the shared `pi-ai` refreshers                                                                                           |
| 25  | `buildAuthDoctorHint`             | Repair hint appended when OAuth refresh fails                                                                  | Provider needs provider-owned auth repair guidance after refresh failure                                                                      |
| 26  | `matchesContextOverflowError`     | Provider-owned context-window overflow matcher                                                                 | Provider has raw overflow errors generic heuristics would miss                                                                                |
| 27  | `classifyFailoverReason`          | Provider-owned failover reason classification                                                                  | Provider can map raw API/transport errors to rate-limit/overload/etc                                                                          |
| 28  | `isCacheTtlEligible`              | Prompt-cache policy for proxy/backhaul providers                                                               | Provider needs proxy-specific cache TTL gating                                                                                                |
| 29  | `buildMissingAuthMessage`         | Replacement for the generic missing-auth recovery message                                                      | Provider needs a provider-specific missing-auth recovery hint                                                                                 |
| 30  | `augmentModelCatalog`             | Synthetic/final catalog rows appended after discovery                                                          | Provider needs synthetic forward-compat rows in `models list` and pickers                                                                     |
| 31  | `resolveThinkingProfile`          | Model-specific `/think` level set, display labels, and default                                                 | Provider exposes a custom thinking ladder or binary label for selected models                                                                 |
| 32  | `isBinaryThinking`                | On/off reasoning toggle compatibility hook                                                                     | Provider exposes only binary thinking on/off                                                                                                  |
| 33  | `supportsXHighThinking`           | `xhigh` reasoning support compatibility hook                                                                   | Provider wants `xhigh` on only a subset of models                                                                                             |
| 34  | `resolveDefaultThinkingLevel`     | Default `/think` level compatibility hook                                                                      | Provider owns default `/think` policy for a model family                                                                                      |
| 35  | `isModernModelRef`                | Modern-model matcher for live profile filters and smoke selection                                              | Provider owns live/smoke preferred-model matching                                                                                             |
| 36  | `prepareRuntimeAuth`              | Exchange a configured credential into the actual runtime token/key just before inference                       | Provider needs a token exchange or short-lived request credential                                                                             |
| 37  | `resolveUsageAuth`                | Resolve usage/billing credentials for `/usage` and related status surfaces                                     | Provider needs custom usage/quota token parsing or a different usage credential                                                               |
| 38  | `fetchUsageSnapshot`              | Fetch and normalize provider-specific usage/quota snapshots after auth is resolved                             | Provider needs a provider-specific usage endpoint or payload parser                                                                           |
| 39  | `createEmbeddingProvider`         | Build a provider-owned embedding adapter for memory/search                                                     | Memory embedding behavior belongs with the provider plugin                                                                                    |
| 40  | `buildReplayPolicy`               | Return a replay policy controlling transcript handling for the provider                                        | Provider needs custom transcript policy (for example, thinking-block stripping)                                                               |
| 41  | `sanitizeReplayHistory`           | Rewrite replay history after generic transcript cleanup                                                        | Provider needs provider-specific replay rewrites beyond shared compaction helpers                                                             |
| 42  | `validateReplayTurns`             | Final replay-turn validation or reshaping before the embedded runner                                           | Provider transport needs stricter turn validation after generic sanitation                                                                    |
| 43  | `onModelSelected`                 | Run provider-owned post-selection side effects                                                                 | Provider needs telemetry or provider-owned state when a model becomes active                                                                  |

`normalizeModelId`, `normalizeTransport`, and `normalizeConfig` first check the
matched provider plugin, then fall through other hook-capable provider plugins
until one actually changes the model id or transport/config. That keeps
alias/compat provider shims working without requiring the caller to know which
bundled plugin owns the rewrite. If no provider hook rewrites a supported
Google-family config entry, the bundled Google config normalizer still applies
that compatibility cleanup.

If the provider needs a fully custom wire protocol or custom request executor,
that is a different class of extension. These hooks are for provider behavior
that still runs on OpenClaw's normal inference loop.

### Provider example

```ts
api.registerProvider({
  id: "example-proxy",
  label: "Example Proxy",
  auth: [],
  catalog: {
    order: "simple",
    run: async (ctx) => {
      const apiKey = ctx.resolveProviderApiKey("example-proxy").apiKey;
      if (!apiKey) {
        return null;
      }
      return {
        provider: {
          baseUrl: "https://proxy.example.com/v1",
          apiKey,
          api: "openai-completions",
          models: [{ id: "auto", name: "Auto" }],
        },
      };
    },
  },
  resolveDynamicModel: (ctx) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "example-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }),
  prepareRuntimeAuth: async (ctx) => {
    const exchanged = await exchangeToken(ctx.apiKey);
    return {
      apiKey: exchanged.token,
      baseUrl: exchanged.baseUrl,
      expiresAt: exchanged.expiresAt,
    };
  },
  resolveUsageAuth: async (ctx) => {
    const auth = await ctx.resolveOAuthToken();
    return auth ? { token: auth.token } : null;
  },
  fetchUsageSnapshot: async (ctx) => {
    return await fetchExampleProxyUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
  },
});
```

### Built-in examples

Bundled provider plugins combine the hooks above to fit each vendor's catalog,
auth, thinking, replay, and usage needs. The authoritative hook set lives with
each plugin under `extensions/`; this page illustrates the shapes rather than
mirroring the list.

<AccordionGroup>
  <Accordion title="Pass-through catalog providers">
    OpenRouter, Kilocode, Z.AI, xAI register `catalog` plus
    `resolveDynamicModel` / `prepareDynamicModel` so they can surface upstream
    model ids ahead of OpenClaw's static catalog.
  </Accordion>
  <Accordion title="OAuth and usage endpoint providers">
    GitHub Copilot, Gemini CLI, ChatGPT Codex, MiniMax, Xiaomi, z.ai pair
    `prepareRuntimeAuth` or `formatApiKey` with `resolveUsageAuth` +
    `fetchUsageSnapshot` to own token exchange and `/usage` integration.
  </Accordion>
  <Accordion title="Replay and transcript cleanup families">
    Shared named families (`google-gemini`, `passthrough-gemini`,
    `anthropic-by-model`, `hybrid-anthropic-openai`) let providers opt into
    transcript policy via `buildReplayPolicy` instead of each plugin
    re-implementing cleanup.
  </Accordion>
  <Accordion title="Catalog-only providers">
    `byteplus`, `cloudflare-ai-gateway`, `huggingface`, `kimi-coding`, `nvidia`,
    `qianfan`, `synthetic`, `together`, `venice`, `vercel-ai-gateway`, and
    `volcengine` register just `catalog` and ride the shared inference loop.
  </Accordion>
  <Accordion title="Anthropic-specific stream helpers">
    Beta headers, `/fast` / `serviceTier`, and `context1m` live inside the
    Anthropic plugin's public `api.ts` / `contract-api.ts` seam
    (`wrapAnthropicProviderStream`, `resolveAnthropicBetas`,
    `resolveAnthropicFastMode`, `resolveAnthropicServiceTier`) rather than in
    the generic SDK.
  </Accordion>
</AccordionGroup>

## Runtime helpers

Plugins can access selected core helpers via `api.runtime`. For TTS:

```ts
const clip = await api.runtime.tts.textToSpeech({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const voices = await api.runtime.tts.listVoices({
  provider: "elevenlabs",
  cfg: api.config,
});
```

Notes:

- `textToSpeech` returns the normal core TTS output payload for file/voice-note surfaces.
- Uses core `messages.tts` configuration and provider selection.
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- `listVoices` is optional per provider. Use it for vendor-owned voice pickers or setup flows.
- Voice listings can include richer metadata such as locale, gender, and personality tags for provider-aware pickers.
- OpenAI and ElevenLabs support telephony today. Microsoft does not.

Plugins can also register speech providers via `api.registerSpeechProvider(...)`.

```ts
api.registerSpeechProvider({
  id: "acme-speech",
  label: "Acme Speech",
  isConfigured: ({ config }) => Boolean(config.messages?.tts),
  synthesize: async (req) => {
    return {
      audioBuffer: Buffer.from([]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    };
  },
});
```

Notes:

- Keep TTS policy, fallback, and reply delivery in core.
- Use speech providers for vendor-owned synthesis behavior.
- Legacy Microsoft `edge` input is normalized to the `microsoft` provider id.
- The preferred ownership model is company-oriented: one vendor plugin can own
  text, speech, image, and future media providers as OpenClaw adds those
  capability contracts.

For image/audio/video understanding, plugins register one typed
media-understanding provider instead of a generic key/value bag:

```ts
api.registerMediaUnderstandingProvider({
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: async (req) => ({ text: "..." }),
  transcribeAudio: async (req) => ({ text: "..." }),
  describeVideo: async (req) => ({ text: "..." }),
});
```

Notes:

- Keep orchestration, fallback, config, and channel wiring in core.
- Keep vendor behavior in the provider plugin.
- Additive expansion should stay typed: new optional methods, new optional
  result fields, new optional capabilities.
- Video generation already follows the same pattern:
  - core owns the capability contract and runtime helper
  - vendor plugins register `api.registerVideoGenerationProvider(...)`
  - feature/channel plugins consume `api.runtime.videoGeneration.*`

For media-understanding runtime helpers, plugins can call:

```ts
const image = await api.runtime.mediaUnderstanding.describeImageFile({
  filePath: "/tmp/inbound-photo.jpg",
  cfg: api.config,
  agentDir: "/tmp/agent",
});

const video = await api.runtime.mediaUnderstanding.describeVideoFile({
  filePath: "/tmp/inbound-video.mp4",
  cfg: api.config,
});
```

For audio transcription, plugins can use either the media-understanding runtime
or the older STT alias:

```ts
const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // Optional when MIME cannot be inferred reliably:
  mime: "audio/ogg",
});
```

Notes:

- `api.runtime.mediaUnderstanding.*` is the preferred shared surface for
  image/audio/video understanding.
- Uses core media-understanding audio configuration (`tools.media.audio`) and provider fallback order.
- Returns `{ text: undefined }` when no transcription output is produced (for example skipped/unsupported input).
- `api.runtime.stt.transcribeAudioFile(...)` remains as a compatibility alias.

Plugins can also launch background subagent runs through `api.runtime.subagent`:

```ts
const result = await api.runtime.subagent.run({
  sessionKey: "agent:main:subagent:search-helper",
  message: "Expand this query into focused follow-up searches.",
  provider: "openai",
  model: "gpt-4.1-mini",
  deliver: false,
});
```

Notes:

- `provider` and `model` are optional per-run overrides, not persistent session changes.
- OpenClaw only honors those override fields for trusted callers.
- For plugin-owned fallback runs, operators must opt in with `plugins.entries.<id>.subagent.allowModelOverride: true`.
- Use `plugins.entries.<id>.subagent.allowedModels` to restrict trusted plugins to specific canonical `provider/model` targets, or `"*"` to allow any target explicitly.
- Untrusted plugin subagent runs still work, but override requests are rejected instead of silently falling back.
- Plugin-created subagent sessions are tagged with the creating plugin id. Fallback `api.runtime.subagent.deleteSession(...)` may delete those owned sessions only; arbitrary session deletion still requires an admin-scoped Gateway request.

For web search, plugins can consume the shared runtime helper instead of
reaching into the agent tool wiring:

```ts
const providers = api.runtime.webSearch.listProviders({
  config: api.config,
});

const result = await api.runtime.webSearch.search({
  config: api.config,
  args: {
    query: "OpenClaw plugin runtime helpers",
    count: 5,
  },
});
```

Plugins can also register web-search providers via
`api.registerWebSearchProvider(...)`.

Notes:

- Keep provider selection, credential resolution, and shared request semantics in core.
- Use web-search providers for vendor-specific search transports.
- `api.runtime.webSearch.*` is the preferred shared surface for feature/channel plugins that need search behavior without depending on the agent tool wrapper.

### `api.runtime.imageGeneration`

```ts
const result = await api.runtime.imageGeneration.generate({
  config: api.config,
  args: { prompt: "A friendly lobster mascot", size: "1024x1024" },
});

const providers = api.runtime.imageGeneration.listProviders({
  config: api.config,
});
```

- `generate(...)`: generate an image using the configured image-generation provider chain.
- `listProviders(...)`: list available image-generation providers and their capabilities.

## Gateway HTTP routes

Plugins can expose HTTP endpoints with `api.registerHttpRoute(...)`.

```ts
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",
  match: "exact",
  handler: async (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;
  },
});
```

Route fields:

- `path`: route path under the gateway HTTP server.
- `auth`: required. Use `"gateway"` to require normal gateway auth, or `"plugin"` for plugin-managed auth/webhook verification.
- `match`: optional. `"exact"` (default) or `"prefix"`.
- `replaceExisting`: optional. Allows the same plugin to replace its own existing route registration.
- `handler`: return `true` when the route handled the request.

Notes:

- `api.registerHttpHandler(...)` was removed and will cause a plugin-load error. Use `api.registerHttpRoute(...)` instead.
- Plugin routes must declare `auth` explicitly.
- Exact `path + match` conflicts are rejected unless `replaceExisting: true`, and one plugin cannot replace another plugin's route.
- Overlapping routes with different `auth` levels are rejected. Keep `exact`/`prefix` fallthrough chains on the same auth level only.
- `auth: "plugin"` routes do **not** receive operator runtime scopes automatically. They are for plugin-managed webhooks/signature verification, not privileged Gateway helper calls.
- `auth: "gateway"` routes run inside a Gateway request runtime scope, but that scope is intentionally conservative:
  - shared-secret bearer auth (`gateway.auth.mode = "token"` / `"password"`) keeps plugin-route runtime scopes pinned to `operator.write`, even if the caller sends `x-openclaw-scopes`
  - trusted identity-bearing HTTP modes (for example `trusted-proxy` or `gateway.auth.mode = "none"` on a private ingress) honor `x-openclaw-scopes` only when the header is explicitly present
  - if `x-openclaw-scopes` is absent on those identity-bearing plugin-route requests, runtime scope falls back to `operator.write`
- Practical rule: do not assume a gateway-auth plugin route is an implicit admin surface. If your route needs admin-only behavior, require an identity-bearing auth mode and document the explicit `x-openclaw-scopes` header contract.

## Plugin SDK import paths

Use narrow SDK subpaths instead of the monolithic `openclaw/plugin-sdk` root
barrel when authoring new plugins. Core subpaths:

| Subpath                             | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `openclaw/plugin-sdk/plugin-entry`  | Plugin registration primitives                     |
| `openclaw/plugin-sdk/channel-core`  | Channel entry/build helpers                        |
| `openclaw/plugin-sdk/core`          | Generic shared helpers and umbrella contract       |
| `openclaw/plugin-sdk/config-schema` | Root `openclaw.json` Zod schema (`OpenClawSchema`) |

Channel plugins pick from a family of narrow seams — `channel-setup`,
`setup-runtime`, `setup-adapter-runtime`, `setup-tools`, `channel-pairing`,
`channel-contract`, `channel-feedback`, `channel-inbound`, `channel-lifecycle`,
`channel-reply-pipeline`, `command-auth`, `secret-input`, `webhook-ingress`,
`channel-targets`, and `channel-actions`. Approval behavior should consolidate
on one `approvalCapability` contract rather than mixing across unrelated
plugin fields. See [Channel plugins](/plugins/sdk-channel-plugins).

Runtime and config helpers live under matching focused `*-runtime` subpaths
(`approval-runtime`, `agent-runtime`, `lazy-runtime`, `directory-runtime`,
`text-runtime`, `runtime-store`, `system-event-runtime`, `heartbeat-runtime`,
`channel-activity-runtime`, etc.). Prefer `config-types`,
`plugin-config-runtime`, `runtime-config-snapshot`, and `config-mutation`
instead of the broad `config-runtime` compatibility barrel.

<Info>
`openclaw/plugin-sdk/channel-runtime`, `openclaw/plugin-sdk/config-runtime`,
and `openclaw/plugin-sdk/infra-runtime` are deprecated compatibility shims for
older plugins. New code should import narrower generic primitives instead.
</Info>

Repo-internal entry points (per bundled plugin package root):

- `index.js` — bundled plugin entry
- `api.js` — helper/types barrel
- `runtime-api.js` — runtime-only barrel
- `setup-entry.js` — setup plugin entry

External plugins should only import `openclaw/plugin-sdk/*` subpaths. Never
import another plugin package's `src/*` from core or from another plugin.
Facade-loaded entry points prefer the active runtime config snapshot when one
exists, then fall back to the resolved config file on disk.

Capability-specific subpaths such as `image-generation`, `media-understanding`,
and `speech` exist because bundled plugins use them today. They are not
automatically long-term frozen external contracts — check the relevant SDK
reference page when relying on them.

## Message tool schemas

Plugins should own channel-specific `describeMessageTool(...)` schema
contributions for non-message primitives such as reactions, reads, and polls.
Shared send presentation should use the generic `MessagePresentation` contract
instead of provider-native button, component, block, or card fields.
See [Message Presentation](/plugins/message-presentation) for the contract,
fallback rules, provider mapping, and plugin author checklist.

Send-capable plugins declare what they can render through message capabilities:

- `presentation` for semantic presentation blocks (`text`, `context`, `divider`, `buttons`, `select`)
- `delivery-pin` for pinned-delivery requests

Core decides whether to render the presentation natively or degrade it to text.
Do not expose provider-native UI escape hatches from the generic message tool.
Deprecated SDK helpers for legacy native schemas remain exported for existing
third-party plugins, but new plugins should not use them.

## Channel target resolution

Channel plugins should own channel-specific target semantics. Keep the shared
outbound host generic and use the messaging adapter surface for provider rules:

- `messaging.inferTargetChatType({ to })` decides whether a normalized target
  should be treated as `direct`, `group`, or `channel` before directory lookup.
- `messaging.targetResolver.looksLikeId(raw, normalized)` tells core whether an
  input should skip straight to id-like resolution instead of directory search.
- `messaging.targetResolver.resolveTarget(...)` is the plugin fallback when
  core needs a final provider-owned resolution after normalization or after a
  directory miss.
- `messaging.resolveOutboundSessionRoute(...)` owns provider-specific session
  route construction once a target is resolved.

Recommended split:

- Use `inferTargetChatType` for category decisions that should happen before
  searching peers/groups.
- Use `looksLikeId` for "treat this as an explicit/native target id" checks.
- Use `resolveTarget` for provider-specific normalization fallback, not for
  broad directory search.
- Keep provider-native ids like chat ids, thread ids, JIDs, handles, and room
  ids inside `target` values or provider-specific params, not in generic SDK
  fields.

## Config-backed directories

Plugins that derive directory entries from config should keep that logic in the
plugin and reuse the shared helpers from
`openclaw/plugin-sdk/directory-runtime`.

Use this when a channel needs config-backed peers/groups such as:

- allowlist-driven DM peers
- configured channel/group maps
- account-scoped static directory fallbacks

The shared helpers in `directory-runtime` only handle generic operations:

- query filtering
- limit application
- deduping/normalization helpers
- building `ChannelDirectoryEntry[]`

Channel-specific account inspection and id normalization should stay in the
plugin implementation.

## Provider catalogs

Provider plugins can define model catalogs for inference with
`registerProvider({ catalog: { run(...) { ... } } })`.

`catalog.run(...)` returns the same shape OpenClaw writes into
`models.providers`:

- `{ provider }` for one provider entry
- `{ providers }` for multiple provider entries

Use `catalog` when the plugin owns provider-specific model ids, base URL
defaults, or auth-gated model metadata.

`catalog.order` controls when a plugin's catalog merges relative to OpenClaw's
built-in implicit providers:

- `simple`: plain API-key or env-driven providers
- `profile`: providers that appear when auth profiles exist
- `paired`: providers that synthesize multiple related provider entries
- `late`: last pass, after other implicit providers

Later providers win on key collision, so plugins can intentionally override a
built-in provider entry with the same provider id.

Compatibility:

- `discovery` still works as a legacy alias
- if both `catalog` and `discovery` are registered, OpenClaw uses `catalog`

## Read-only channel inspection

If your plugin registers a channel, prefer implementing
`plugin.config.inspectAccount(cfg, accountId)` alongside `resolveAccount(...)`.

Why:

- `resolveAccount(...)` is the runtime path. It is allowed to assume credentials
  are fully materialized and can fail fast when required secrets are missing.
- Read-only command paths such as `openclaw status`, `openclaw status --all`,
  `openclaw channels status`, `openclaw channels resolve`, and doctor/config
  repair flows should not need to materialize runtime credentials just to
  describe configuration.

Recommended `inspectAccount(...)` behavior:

- Return descriptive account state only.
- Preserve `enabled` and `configured`.
- Include credential source/status fields when relevant, such as:
  - `tokenSource`, `tokenStatus`
  - `botTokenSource`, `botTokenStatus`
  - `appTokenSource`, `appTokenStatus`
  - `signingSecretSource`, `signingSecretStatus`
- You do not need to return raw token values just to report read-only
  availability. Returning `tokenStatus: "available"` (and the matching source
  field) is enough for status-style commands.
- Use `configured_unavailable` when a credential is configured via SecretRef but
  unavailable in the current command path.

This lets read-only commands report "configured but unavailable in this command
path" instead of crashing or misreporting the account as not configured.

## Package packs

A plugin directory may include a `package.json` with `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"],
    "setupEntry": "./src/setup-entry.ts"
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

If your plugin imports npm deps, install them in that directory so
`node_modules` is available (`npm install` / `pnpm install`).

Security guardrail: every `openclaw.extensions` entry must stay inside the plugin
directory after symlink resolution. Entries that escape the package directory are
rejected.

Security note: `openclaw plugins install` installs plugin dependencies with a
project-local `npm install --omit=dev --ignore-scripts` (no lifecycle scripts,
no dev dependencies at runtime), ignoring inherited global npm install settings.
Keep plugin dependency trees "pure JS/TS" and avoid packages that require
`postinstall` builds.

Optional: `openclaw.setupEntry` can point at a lightweight setup-only module.
When OpenClaw needs setup surfaces for a disabled channel plugin, or
when a channel plugin is enabled but still unconfigured, it loads `setupEntry`
instead of the full plugin entry. This keeps startup and setup lighter
when your main plugin entry also wires tools, hooks, or other runtime-only
code.

Optional: `openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen`
can opt a channel plugin into the same `setupEntry` path during the gateway's
pre-listen startup phase, even when the channel is already configured.

Use this only when `setupEntry` fully covers the startup surface that must exist
before the gateway starts listening. In practice, that means the setup entry
must register every channel-owned capability that startup depends on, such as:

- channel registration itself
- any HTTP routes that must be available before the gateway starts listening
- any gateway methods, tools, or services that must exist during that same window

If your full entry still owns any required startup capability, do not enable
this flag. Keep the plugin on the default behavior and let OpenClaw load the
full entry during startup.

Bundled channels can also publish setup-only contract-surface helpers that core
can consult before the full channel runtime is loaded. The current setup
promotion surface is:

- `singleAccountKeysToMove`
- `namedAccountPromotionKeys`
- `resolveSingleAccountPromotionTarget(...)`

Core uses that surface when it needs to promote a legacy single-account channel
config into `channels.<id>.accounts.*` without loading the full plugin entry.
Matrix is the current bundled example: it moves only auth/bootstrap keys into a
named promoted account when named accounts already exist, and it can preserve a
configured non-canonical default-account key instead of always creating
`accounts.default`.

Those setup patch adapters keep bundled contract-surface discovery lazy. Import
time stays light; the promotion surface is loaded only on first use instead of
re-entering bundled channel startup on module import.

When those startup surfaces include gateway RPC methods, keep them on a
plugin-specific prefix. Core admin namespaces (`config.*`,
`exec.approvals.*`, `wizard.*`, `update.*`) remain reserved and always resolve
to `operator.admin`, even if a plugin requests a narrower scope.

Example:

```json
{
  "name": "@scope/my-channel",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

### Channel catalog metadata

Channel plugins can advertise setup/discovery metadata via `openclaw.channel` and
install hints via `openclaw.install`. This keeps the core catalog data-free.

Example:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "<bundled-plugin-local-path>",
      "defaultChoice": "npm"
    }
  }
}
```

Useful `openclaw.channel` fields beyond the minimal example:

- `detailLabel`: secondary label for richer catalog/status surfaces
- `docsLabel`: override link text for the docs link
- `preferOver`: lower-priority plugin/channel ids this catalog entry should outrank
- `selectionDocsPrefix`, `selectionDocsOmitLabel`, `selectionExtras`: selection-surface copy controls
- `markdownCapable`: marks the channel as markdown-capable for outbound formatting decisions
- `exposure.configured`: hide the channel from configured-channel listing surfaces when set to `false`
- `exposure.setup`: hide the channel from interactive setup/configure pickers when set to `false`
- `exposure.docs`: mark the channel as internal/private for docs navigation surfaces
- `showConfigured` / `showInSetup`: legacy aliases still accepted for compatibility; prefer `exposure`
- `quickstartAllowFrom`: opt the channel into the standard quickstart `allowFrom` flow
- `forceAccountBinding`: require explicit account binding even when only one account exists
- `preferSessionLookupForAnnounceTarget`: prefer session lookup when resolving announce targets

OpenClaw can also merge **external channel catalogs** (for example, an MPM
registry export). Drop a JSON file at one of:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Or point `OPENCLAW_PLUGIN_CATALOG_PATHS` (or `OPENCLAW_MPM_CATALOG_PATHS`) at
one or more JSON files (comma/semicolon/`PATH`-delimited). Each file should
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`. The parser also accepts `"packages"` or `"plugins"` as legacy aliases for the `"entries"` key.

Generated channel catalog entries and provider install catalog entries expose
normalized install-source facts next to the raw `openclaw.install` block. The
normalized facts identify whether the npm spec is an exact version or floating
selector, whether expected integrity metadata is present, and whether a local
source path is also available. When the catalog/package identity is known, the
normalized facts warn if the parsed npm package name drifts from that identity.
They also warn when `defaultChoice` is invalid or points at a source that is
not available, and when npm integrity metadata is present without a valid npm
source. Consumers should treat `installSource` as an additive optional field so
hand-built entries and catalog shims do not have to synthesize it.
This lets onboarding and diagnostics explain source-plane state without
importing plugin runtime.

Official external npm entries should prefer an exact `npmSpec` plus
`expectedIntegrity`. Bare package names and dist-tags still work for
compatibility, but they surface source-plane warnings so the catalog can move
toward pinned, integrity-checked installs without breaking existing plugins.
When onboarding installs from a local catalog path, it records a managed plugin
plugin index entry with `source: "path"` and a workspace-relative
`sourcePath` when possible. The absolute operational load path stays in
`plugins.load.paths`; the install record avoids duplicating local workstation
paths into long-lived config. This keeps local development installs visible to
source-plane diagnostics without adding a second raw filesystem-path disclosure
surface. The persisted `plugins/installs.json` plugin index is the install
source of truth and can be refreshed without loading plugin runtime modules.
Its `installRecords` map is durable even when a plugin manifest is missing or
invalid; its `plugins` array is a rebuildable manifest view.

## Context engine plugins

Context engine plugins own session context orchestration for ingest, assembly,
and compaction. Register them from your plugin with
`api.registerContextEngine(id, factory)`, then select the active engine with
`plugins.slots.contextEngine`.

Use this when your plugin needs to replace or extend the default context
pipeline rather than just add memory search or hooks.

```ts
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("lossless-claw", (ctx) => ({
    info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
}
```

The factory `ctx` exposes optional `config`, `agentDir`, and `workspaceDir`
values for construction-time initialization.

If your engine does **not** own the compaction algorithm, keep `compact()`
implemented and delegate it explicitly:

```ts
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("my-memory-engine", (ctx) => ({
    info: {
      id: "my-memory-engine",
      name: "My Memory Engine",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },
    async compact(params) {
      return await delegateCompactionToRuntime(params);
    },
  }));
}
```

## Adding a new capability

When a plugin needs behavior that does not fit the current API, do not bypass
the plugin system with a private reach-in. Add the missing capability.

Recommended sequence:

1. define the core contract
   Decide what shared behavior core should own: policy, fallback, config merge,
   lifecycle, channel-facing semantics, and runtime helper shape.
2. add typed plugin registration/runtime surfaces
   Extend `OpenClawPluginApi` and/or `api.runtime` with the smallest useful
   typed capability surface.
3. wire core + channel/feature consumers
   Channels and feature plugins should consume the new capability through core,
   not by importing a vendor implementation directly.
4. register vendor implementations
   Vendor plugins then register their backends against the capability.
5. add contract coverage
   Add tests so ownership and registration shape stay explicit over time.

This is how OpenClaw stays opinionated without becoming hardcoded to one
provider's worldview. See the [Capability Cookbook](/tools/capability-cookbook)
for a concrete file checklist and worked example.

### Capability checklist

When you add a new capability, the implementation should usually touch these
surfaces together:

- core contract types in `src/<capability>/types.ts`
- core runner/runtime helper in `src/<capability>/runtime.ts`
- plugin API registration surface in `src/plugins/types.ts`
- plugin registry wiring in `src/plugins/registry.ts`
- plugin runtime exposure in `src/plugins/runtime/*` when feature/channel
  plugins need to consume it
- capture/test helpers in `src/test-utils/plugin-registration.ts`
- ownership/contract assertions in `src/plugins/contracts/registry.ts`
- operator/plugin docs in `docs/`

If one of those surfaces is missing, that is usually a sign the capability is
not fully integrated yet.

### Capability template

Minimal pattern:

```ts
// core contract
export type VideoGenerationProviderPlugin = {
  id: string;
  label: string;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

// plugin API
api.registerVideoGenerationProvider({
  id: "openai",
  label: "OpenAI",
  async generateVideo(req) {
    return await generateOpenAiVideo(req);
  },
});

// shared runtime helper for feature/channel plugins
const clip = await api.runtime.videoGeneration.generate({
  prompt: "Show the robot walking through the lab.",
  cfg,
});
```

Contract test pattern:

```ts
expect(findVideoGenerationProviderIdsForPlugin("openai")).toEqual(["openai"]);
```

That keeps the rule simple:

- core owns the capability contract + orchestration
- vendor plugins own vendor implementations
- feature/channel plugins consume runtime helpers
- contract tests keep ownership explicit

## Related

- [Plugin architecture](/plugins/architecture) — public capability model and shapes
- [Plugin SDK subpaths](/plugins/sdk-subpaths)
- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
