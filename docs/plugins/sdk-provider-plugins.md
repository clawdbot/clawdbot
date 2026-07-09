---
summary: "Step-by-step guide to building a model provider plugin for OpenClaw"
title: "Building provider plugins"
sidebarTitle: "Provider plugins"
read_when:
  - You are building a new model provider plugin
  - You want to add an OpenAI-compatible proxy or custom LLM to OpenClaw
  - You need to understand provider auth, catalogs, and runtime hooks
---

Build a provider plugin to add a model provider (LLM) to OpenClaw: a model
catalog, API-key auth, and dynamic model resolution.

<Info>
  New to OpenClaw plugins? Read [Getting Started](/plugins/building-plugins)
  first for package structure and manifest setup.
</Info>

<Tip>
  Provider plugins add models to OpenClaw's normal inference loop. If the
  model must run through a native agent daemon that owns threads, compaction,
  or tool events, pair the provider with an [agent
  harness](/plugins/sdk-agent-harness) instead of putting daemon protocol
  details in core.
</Tip>

## Walkthrough

<Steps>
  <Step title="Package and manifest">
    ### Step 1: Package and manifest

    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-ai",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "providers": ["acme-ai"],
        "compat": {
          "pluginApi": ">=2026.3.24-beta.2",
          "minGatewayVersion": "2026.3.24-beta.2"
        },
        "build": {
          "openclawVersion": "2026.3.24-beta.2",
          "pluginSdkVersion": "2026.3.24-beta.2"
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-ai",
      "name": "Acme AI",
      "description": "Acme AI model provider",
      "providers": ["acme-ai"],
      "modelSupport": {
        "modelPrefixes": ["acme-"]
      },
      "setup": {
        "providers": [
          {
            "id": "acme-ai",
            "envVars": ["ACME_AI_API_KEY"]
          }
        ]
      },
      "providerAuthAliases": {
        "acme-ai-coding": "acme-ai"
      },
      "providerAuthChoices": [
        {
          "provider": "acme-ai",
          "method": "api-key",
          "choiceId": "acme-ai-api-key",
          "choiceLabel": "Acme AI API key",
          "groupId": "acme-ai",
          "groupLabel": "Acme AI",
          "cliFlag": "--acme-ai-api-key",
          "cliOption": "--acme-ai-api-key <key>",
          "cliDescription": "Acme AI API key"
        }
      ],
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    `setup.providers[].envVars` lets OpenClaw detect credentials without
    loading your plugin runtime. Add `providerAuthAliases` when a provider
    variant should reuse another provider id's auth. `modelSupport` is
    optional and lets OpenClaw auto-load your provider plugin from shorthand
    model ids like `acme-large` before runtime hooks exist. `openclaw.compat`
    and `openclaw.build` in `package.json` are required for ClawHub
    publishing (`openclaw.compat.pluginApi` and `openclaw.build.openclawVersion`
    are the two required fields; `minGatewayVersion` falls back to
    `openclaw.install.minHostVersion` when omitted).

  </Step>

  <Step title="Register the provider">
    A minimal text provider needs an `id`, `label`, `auth`, and `catalog`.
    `catalog` is the provider-owned runtime/config hook; it can call live
    vendor APIs and returns `models.providers` entries.

    ```typescript index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

    export default definePluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI model provider",
      register(api) {
        api.registerProvider({
          id: "acme-ai",
          label: "Acme AI",
          docsPath: "/providers/acme-ai",
          envVars: ["ACME_AI_API_KEY"],

          auth: [
            createProviderApiKeyAuthMethod({
              providerId: "acme-ai",
              methodId: "api-key",
              label: "Acme AI API key",
              hint: "API key from your Acme AI dashboard",
              optionKey: "acmeAiApiKey",
              flagName: "--acme-ai-api-key",
              envVar: "ACME_AI_API_KEY",
              promptMessage: "Enter your Acme AI API key",
              defaultModel: "acme-ai/acme-large",
            }),
          ],

          catalog: {
            order: "simple",
            run: async (ctx) => {
              const apiKey =
                ctx.resolveProviderApiKey("acme-ai").apiKey;
              if (!apiKey) return null;
              return {
                provider: {
                  baseUrl: "https://api.acme-ai.com/v1",
                  apiKey,
                  api: "openai-completions",
                  models: [
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
                  ],
                },
              };
            },
          },
        });

        api.registerModelCatalogProvider({
          provider: "acme-ai",
          kinds: ["text"],
          liveCatalog: async (ctx) => {
            const apiKey = ctx.resolveProviderApiKey("acme-ai").apiKey;
            if (!apiKey) return null;
            return [
              {
                kind: "text",
                provider: "acme-ai",
                model: "acme-large",
                label: "Acme Large",
                source: "live",
              },
            ];
          },
        });
      },
    });
    ```

    `registerModelCatalogProvider` is the newer control-plane catalog surface
    for list/help/picker UI, covering `text`, `voice`, `image_generation`,
    `video_generation`, and `music_generation` rows. Keep vendor endpoint
    calls and response mapping in the plugin; OpenClaw owns the shared row
    shape, source labels, and help rendering.

    That is a working provider. Users can now run
    `openclaw onboard --acme-ai-api-key <key>` and select
    `acme-ai/acme-large` as their model.

    ### Live model discovery

    If your provider exposes a `/models`-style API, keep the provider-specific
    endpoint and row projection in your plugin and use
    `openclaw/plugin-sdk/provider-catalog-live-runtime` for the shared fetch
    lifecycle. The helper gives you guarded HTTP fetches, provider-auth headers,
    structured HTTP errors, TTL caching, and static fallback behavior without
    putting provider policy in OpenClaw core.

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
              const apiKey =
                auth.apiKey ?? ctx.resolveProviderApiKey("acme-ai").apiKey;
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

    Use `getCachedLiveProviderModelRows` when the provider API returns richer
    metadata and the plugin needs to project rows into OpenClaw model
    definitions itself:

    ```typescript index.ts
    import {
      getCachedLiveProviderModelRows,
      LiveModelCatalogHttpError,
    } from "openclaw/plugin-sdk/provider-catalog-live-runtime";

    async function discoverAcmeModels(apiKey: string) {
      try {
        const rows = await getCachedLiveProviderModelRows({
          providerId: "acme-ai",
          endpoint: "https://api.acme-ai.com/v1/models",
          apiKey,
          ttlMs: 60_000,
          auditContext: "acme-ai-model-discovery",
        });
        return rows
          .map((row) => projectAcmeModel(row))
          .filter((model) => model !== null);
      } catch (error) {
        if (error instanceof LiveModelCatalogHttpError) {
          return STATIC_MODELS;
        }
        throw error;
      }
    }
    ```

    `run` should stay auth-gated and return `null` when no usable credential is
    available. Keep an offline `staticRun` or static fallback so setup, docs,
    tests, and picker surfaces do not depend on live network access. Use a TTL
    appropriate for model-list freshness, avoid request-time filesystem polling,
    and pass a provider-specific `readRows` / `readModelId` only when the
    upstream response is not an OpenAI-compatible `{ data: [{ id, object }] }`
    shape.

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

  </Step>

  <Step title="Add dynamic model resolution">
    If your provider accepts arbitrary model IDs (like a proxy or router),
    add `resolveDynamicModel`:

    ```typescript
    api.registerProvider({
      // ... id, label, auth, catalog from above

      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: ctx.modelId,
        provider: "acme-ai",
        api: "openai-completions",
        baseUrl: "https://api.acme-ai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }),
    });
    ```

    If resolving requires a network call, use `prepareDynamicModel` for async
    warm-up - `resolveDynamicModel` runs again after it completes.

  </Step>

  <Step title="Add runtime hooks (as needed)">
    Most providers only need `catalog` + `resolveDynamicModel`. Add hooks
    incrementally as your provider requires them.

    Shared helper builders now cover the most common replay/tool-compat
    families, so plugins usually do not need to hand-wire each hook one by one:

    ```typescript
    import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
    import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream";
    import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";

    const GOOGLE_FAMILY_HOOKS = {
      ...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
      ...buildProviderStreamFamilyHooks("google-thinking"),
      ...buildProviderToolCompatFamilyHooks("gemini"),
    };

    api.registerProvider({
      id: "acme-gemini-compatible",
      // ...
      ...GOOGLE_FAMILY_HOOKS,
    });
    ```

    Available replay families today:

    | Family | What it wires in | Bundled examples |
    | --- | --- | --- |
    | `openai-compatible` | Shared OpenAI-style replay policy for OpenAI-compatible transports, including tool-call-id sanitation, assistant-first ordering fixes, and generic Gemini-turn validation where the transport needs it | `moonshot`, `ollama`, `xai`, `zai` |
    | `anthropic-by-model` | Claude-aware replay policy chosen by `modelId`, so Anthropic-message transports only get Claude-specific thinking-block cleanup when the resolved model is actually a Claude id | `amazon-bedrock` |
    | `native-anthropic-by-model` | Same Claude-by-model policy as `anthropic-by-model`, plus tool-call-id sanitation and native Anthropic tool-use id preservation for transports that must keep vendor-native ids | `anthropic-vertex`, `clawrouter` |
    | `google-gemini` | Native Gemini replay policy plus bootstrap replay sanitation. The shared family keeps the text-output Gemini CLI on tagged reasoning; the direct `google` provider overrides `resolveReasoningOutputMode` to `native` because Gemini API thinking arrives as native thought parts. | `google`, `google-gemini-cli` |
    | `passthrough-gemini` | Gemini thought-signature sanitation for Gemini models running through OpenAI-compatible proxy transports; does not enable native Gemini replay validation or bootstrap rewrites | `openrouter`, `kilocode`, `opencode`, `opencode-go` |
    | `hybrid-anthropic-openai` | Hybrid policy for providers that mix Anthropic-message and OpenAI-compatible model surfaces in one plugin; optional Claude-only thinking-block dropping stays scoped to the Anthropic side | `minimax` |

    Available stream families today:

    | Family | What it wires in | Bundled examples |
    | --- | --- | --- |
    | `google-thinking` | Gemini thinking payload normalization on the shared stream path | `google`, `google-gemini-cli` |
    | `kilocode-thinking` | Kilo reasoning wrapper on the shared proxy stream path, with `kilo/auto` and unsupported proxy reasoning ids skipping injected thinking | `kilocode` |
    | `moonshot-thinking` | Moonshot binary native-thinking payload mapping from config + `/think` level | `moonshot` |
    | `minimax-fast-mode` | MiniMax fast-mode model rewrite on the shared stream path | `minimax`, `minimax-portal` |
    | `openai-responses-defaults` | Shared native OpenAI/Codex Responses wrappers: attribution headers, `/fast`/`serviceTier`, text verbosity, native Codex web search, reasoning-compat payload shaping, and Responses context management | `openai` |
    | `openrouter-thinking` | OpenRouter reasoning wrapper for proxy routes, with unsupported-model/`auto` skips handled centrally | `openrouter` |
    | `tool-stream-default-on` | Default-on `tool_stream` wrapper for providers like Z.AI that want tool streaming unless explicitly disabled | `zai` |

    <Accordion title="SDK seams powering the family builders">
      Each family builder is composed from lower-level public helpers exported from the same package, which you can reach for when a provider needs to go off the common pattern:

      - `openclaw/plugin-sdk/provider-model-shared` - `ProviderReplayFamily`, `buildProviderReplayFamilyHooks(...)`, and the raw replay builders (`buildOpenAICompatibleReplayPolicy`, `buildAnthropicReplayPolicyForModel`, `buildGoogleGeminiReplayPolicy`, `buildHybridAnthropicOrOpenAIReplayPolicy`). Also exports Gemini replay helpers (`sanitizeGoogleGeminiReplayHistory`, `resolveTaggedReasoningOutputMode`) and endpoint/model helpers (`resolveProviderEndpoint`, `normalizeProviderId`, `normalizeGooglePreviewModelId`).
      - `openclaw/plugin-sdk/provider-stream` - `ProviderStreamFamily`, `buildProviderStreamFamilyHooks(...)`, `composeProviderStreamWrappers(...)`, plus the shared OpenAI/Codex wrappers (`createOpenAIAttributionHeadersWrapper`, `createOpenAIFastModeWrapper`, `createOpenAIServiceTierWrapper`, `createOpenAIResponsesContextManagementWrapper`, `createCodexNativeWebSearchWrapper`), DeepSeek V4 OpenAI-compatible wrapper (`createDeepSeekV4OpenAICompatibleThinkingWrapper`), Anthropic Messages thinking prefill cleanup (`createAnthropicThinkingPrefillPayloadWrapper`), plain-text tool-call compat (`createPlainTextToolCallCompatWrapper`), and shared proxy/provider wrappers (`createOpenRouterWrapper`, `createToolStreamWrapper`, `createMinimaxFastModeWrapper`).
      - `openclaw/plugin-sdk/provider-stream-shared` - lightweight payload and event wrappers for hot provider paths, including `createOpenAICompatibleCompletionsThinkingOffWrapper`, `createPayloadPatchStreamWrapper`, `createPlainTextToolCallCompatWrapper`, `normalizeOpenAICompatibleReasoningPayload(...)`, and `setQwenChatTemplateThinking(...)`.
      - `openclaw/plugin-sdk/provider-tools` - `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks("deepseek" | "gemini" | "openai")`, and underlying provider schema helpers.

      For Gemini-family providers, keep the reasoning-output mode aligned with
      the transport. Direct Google Gemini API providers should use `native`
      reasoning output so OpenClaw consumes native thought parts without adding
      `<think>` / `<final>` prompt directives. Text-only Gemini CLI-style
      backends that parse a final JSON/text response can keep the shared
      `google-gemini` tagged contract.

      Some stream helpers stay provider-local on purpose. `@openclaw/anthropic-provider` keeps `wrapAnthropicProviderStream`, `resolveAnthropicBetas`, `resolveAnthropicFastMode`, `resolveAnthropicServiceTier`, and the lower-level Anthropic wrapper builders in its own public `api.ts` / `contract-api.ts` seam because they encode Claude OAuth beta handling and `context1m` gating. The xAI plugin similarly keeps native xAI Responses shaping in its own `wrapStreamFn` (`/fast` aliases, default `tool_stream`, unsupported strict-tool cleanup, xAI-specific reasoning-payload removal).

      The same package-root pattern also backs `@openclaw/openai-provider` (provider builders, default-model helpers, realtime provider builders) and `@openclaw/openrouter-provider` (provider builder plus onboarding/config helpers).
    </Accordion>

    <Tabs>
      <Tab title="Token exchange">
        For providers that need a token exchange before each inference call:

        ```typescript
        prepareRuntimeAuth: async (ctx) => {
          const exchanged = await exchangeToken(ctx.apiKey);
          return {
            apiKey: exchanged.token,
            baseUrl: exchanged.baseUrl,
            expiresAt: exchanged.expiresAt,
          };
        },
        ```
      </Tab>
      <Tab title="Custom headers">
        For providers that need custom request headers or body modifications:

        ```typescript
        // wrapStreamFn returns a StreamFn derived from ctx.streamFn
        wrapStreamFn: (ctx) => {
          if (!ctx.streamFn) return undefined;
          const inner = ctx.streamFn;
          return async (params) => {
            params.headers = {
              ...params.headers,
              "X-Acme-Version": "2",
            };
            return inner(params);
          };
        },
        ```
      </Tab>
      <Tab title="Native transport identity">
        For providers that need native request/session headers or metadata on
        generic HTTP or WebSocket transports:

        ```typescript
        resolveTransportTurnState: (ctx) => ({
          headers: {
            "x-request-id": ctx.turnId,
          },
          metadata: {
            session_id: ctx.sessionId ?? "",
            turn_id: ctx.turnId,
          },
        }),
        resolveWebSocketSessionPolicy: (ctx) => ({
          headers: {
            "x-session-id": ctx.sessionId ?? "",
          },
          degradeCooldownMs: 60_000,
        }),
        ```
      </Tab>
      <Tab title="Usage and billing">
        For providers that expose usage/billing data:

        ```typescript
        resolveUsageAuth: async (ctx) => {
          const auth = await ctx.resolveOAuthToken();
          return auth ? { token: auth.token } : null;
        },
        fetchUsageSnapshot: async (ctx) => {
          return await fetchAcmeUsage(ctx.token, ctx.timeoutMs);
        },
        ```

        `resolveUsageAuth` has three outcomes. Return
        `{ token, accountId?, subscriptionType?, rateLimitTier? }` when the
        provider has a usage/billing credential (the optional fields carry
        non-secret plan metadata from the resolved profile into
        `fetchUsageSnapshot`). Return
        `{ handled: true }` only when the provider has definitively handled usage
        auth but has no usable usage token, and OpenClaw must skip generic
        API-key/OAuth fallback. Return `null` or `undefined` when the provider did
        not handle the request and OpenClaw should continue with generic fallback.

        Declare the provider id in `contracts.usageProviders`. When that manifest
        contract and **both** hooks are present, OpenClaw automatically includes
        the provider in usage collection without loading unrelated provider
        plugins. No core allowlist update is required.
        `fetchUsageSnapshot` returns the shared provider-neutral shape:

        - `plan`: provider-reported subscription or key label
        - `windows`: resettable quota windows as used percentages
        - `billing`: typed `balance`, `spend`, or `budget` entries; `unit` can be
          an ISO currency or a provider unit such as `credits`
        - `summary`: compact provider-specific context that does not fit those
          structured fields

        Keep currency semantics exact. A provider credit is not USD unless the
        upstream contract says so. A plugin that implements only
        `fetchUsageSnapshot` remains available for explicit/synthetic callers but
        is not auto-discovered, because OpenClaw cannot resolve its usage credential.
      </Tab>
    </Tabs>

    <Accordion title="Common provider hooks">
      OpenClaw calls hooks in roughly this order for model/provider plugins.
      Most providers only use 2-3. This is not the full `ProviderPlugin`
      contract - see [Internals: Provider Runtime
      Hooks](/plugins/architecture-internals#provider-runtime-hooks) for the
      complete, currently-accurate hook list and fallback notes.
      Compatibility-only provider fields that OpenClaw no longer calls, such as
      `ProviderPlugin.capabilities` and `suppressBuiltInModel`, are not listed
      here.

      | Hook | When to use |
      | --- | --- |
      | `catalog` | Model catalog or base URL defaults |
      | `applyConfigDefaults` | Provider-owned global defaults during config materialization |
      | `normalizeModelId` | Legacy/preview model-id alias cleanup before lookup |
      | `normalizeTransport` | Provider-family `api` / `baseUrl` cleanup before generic model assembly |
      | `normalizeConfig` | Normalize `models.providers.<id>` config |
      | `applyNativeStreamingUsageCompat` | Native streaming-usage compat rewrites for config providers |
      | `resolveConfigApiKey` | Provider-owned env-marker auth resolution |
      | `resolveSyntheticAuth` | Local/self-hosted or config-backed synthetic auth |
      | `resolveExternalAuthProfiles` | Overlay provider-owned external auth profiles for CLI/app-managed credentials |
      | `shouldDeferSyntheticProfileAuth` | Lower synthetic stored-profile placeholders behind env/config auth |
      | `resolveDynamicModel` | Accept arbitrary upstream model IDs |
      | `prepareDynamicModel` | Async metadata fetch before resolving |
      | `normalizeResolvedModel` | Transport rewrites before the runner |
      | `normalizeToolSchemas` | Provider-owned tool-schema cleanup before registration |
      | `inspectToolSchemas` | Provider-owned tool-schema diagnostics |
      | `resolveReasoningOutputMode` | Tagged vs native reasoning-output contract |
      | `prepareExtraParams` | Default request params |
      | `createStreamFn` | Fully custom StreamFn transport |
      | `wrapStreamFn` | Custom headers/body wrappers on the normal stream path |
      | `resolveTransportTurnState` | Native per-turn headers/metadata |
      | `resolveWebSocketSessionPolicy` | Native WS session headers/cool-down |
      | `formatApiKey` | Custom runtime token shape |
      | `refreshOAuth` | Custom OAuth refresh |
      | `buildAuthDoctorHint` | Auth repair guidance |
      | `matchesContextOverflowError` | Provider-owned overflow detection |
      | `classifyFailoverReason` | Provider-owned rate-limit/overload classification |
      | `isCacheTtlEligible` | Prompt cache TTL gating |
      | `buildMissingAuthMessage` | Custom missing-auth hint |
      | `augmentModelCatalog` | Synthetic forward-compat rows (deprecated - prefer `registerModelCatalogProvider`) |
      | `resolveThinkingProfile` | Model-specific `/think` option set |
      | `isBinaryThinking` | Binary thinking on/off compatibility (deprecated - prefer `resolveThinkingProfile`) |
      | `supportsXHighThinking` | `xhigh` reasoning support compatibility (deprecated - prefer `resolveThinkingProfile`) |
      | `resolveDefaultThinkingLevel` | Default `/think` policy compatibility (deprecated - prefer `resolveThinkingProfile`) |
      | `isModernModelRef` | Live/smoke model matching |
      | `prepareRuntimeAuth` | Token exchange before inference |
      | `resolveUsageAuth` | Custom usage credential parsing |
      | `fetchUsageSnapshot` | Custom usage endpoint |
      | `createEmbeddingProvider` | Provider-owned embedding adapter for memory/search |
      | `buildReplayPolicy` | Custom transcript replay/compaction policy |
      | `sanitizeReplayHistory` | Provider-specific replay rewrites after generic cleanup |
      | `validateReplayTurns` | Strict replay-turn validation before the embedded runner |
      | `onModelSelected` | Post-selection callback (e.g. telemetry) |

      Runtime fallback notes:

      - `normalizeConfig` resolves one owning plugin per provider id (bundled providers first, then the matched runtime plugin) and calls only that hook - there is no scan across other providers. Google's own `normalizeConfig` hook is what normalizes `google` / `google-vertex` / `google-antigravity` config entries; it is not a separate core fallback.
      - `resolveConfigApiKey` uses the provider hook when exposed. Amazon Bedrock keeps AWS env-marker resolution in its provider plugin; runtime auth itself still uses the AWS SDK default chain when configured with `auth: "aws-sdk"`.
      - `resolveThinkingProfile(ctx)` receives the selected `provider`, `modelId`, optional merged `reasoning` catalog hint, and optional merged model `compat` facts. Use `compat` only to select the provider's thinking UI/profile.
      - `resolveSystemPromptContribution` lets a provider inject cache-aware system-prompt guidance for a model family. Prefer it over the legacy plugin-wide `before_prompt_build` hook when the behavior belongs to one provider/model family and should preserve the stable/dynamic cache split.

    </Accordion>

  </Step>

  <Step title="Add extra capabilities (optional)">
    ### Step 5: Add extra capabilities

    A provider plugin can register embeddings, speech, realtime transcription,
    realtime voice, media understanding, image generation, video generation,
    web fetch, and web search alongside text inference. OpenClaw classifies this as a
    **hybrid-capability** plugin - the recommended pattern for company plugins
    (one plugin per vendor). See
    [Internals: Capability Ownership](/plugins/architecture#capability-ownership-model).

    Register each capability inside `register(api)` alongside your existing
    `api.registerProvider(...)` call. Pick only the tabs you need:

    <Tabs>
      <Tab title="Speech (TTS)">
        ```typescript
        import {
          assertOkOrThrowProviderError,
          postJsonRequest,
        } from "openclaw/plugin-sdk/provider-http";

        api.registerSpeechProvider({
          id: "acme-ai",
          label: "Acme Speech",
          defaultTimeoutMs: 120_000,
          isConfigured: ({ config }) => Boolean(config.messages?.tts),
          synthesize: async (req) => {
            const { response, release } = await postJsonRequest({
              url: "https://api.example.com/v1/speech",
              headers: new Headers({ "Content-Type": "application/json" }),
              body: { text: req.text },
              timeoutMs: req.timeoutMs,
              fetchFn: fetch,
              auditContext: "acme speech",
            });
            try {
              await assertOkOrThrowProviderError(response, "Acme Speech API error");
              return {
                audioBuffer: Buffer.from(await response.arrayBuffer()),
                outputFormat: "mp3",
                fileExtension: ".mp3",
                voiceCompatible: false,
              };
            } finally {
              await release();
            }
          },
        });
        ```

        Use `assertOkOrThrowProviderError(...)` for provider HTTP failures so
        plugins share capped error-body reads, JSON error parsing, and
        request-id suffixes.
      </Tab>
      <Tab title="Realtime transcription">
        Prefer `createRealtimeTranscriptionWebSocketSession(...)` - the shared
        helper handles proxy capture, reconnect backoff, close flushing, ready
        handshakes, audio queueing, and close-event diagnostics. Your plugin
        only maps upstream events.

        ```typescript
        api.registerRealtimeTranscriptionProvider({
          id: "acme-ai",
          label: "Acme Realtime Transcription",
          isConfigured: () => true,
          createSession: (req) => {
            const apiKey = String(req.providerConfig.apiKey ?? "");
            return createRealtimeTranscriptionWebSocketSession({
              providerId: "acme-ai",
              callbacks: req,
              url: "wss://api.example.com/v1/realtime-transcription",
              headers: { Authorization: `Bearer ${apiKey}` },
              onMessage: (event, transport) => {
                if (event.type === "session.created") {
                  transport.sendJson({ type: "session.update" });
                  transport.markReady();
                  return;
                }
                if (event.type === "transcript.final") {
                  req.onTranscript?.(event.text);
                }
              },
              sendAudio: (audio, transport) => {
                transport.sendJson({
                  type: "audio.append",
                  audio: audio.toString("base64"),
                });
              },
              onClose: (transport) => {
                transport.sendJson({ type: "audio.end" });
              },
            });
          },
        });
        ```

        Batch STT providers that POST multipart audio should use
        `buildAudioTranscriptionFormData(...)` from
        `openclaw/plugin-sdk/provider-http`. The helper normalizes upload
        filenames, including AAC uploads that need an M4A-style filename for
        compatible transcription APIs.
      </Tab>
      <Tab title="Realtime voice">
        ```typescript
        api.registerRealtimeVoiceProvider({
          id: "acme-ai",
          label: "Acme Realtime Voice",
          capabilities: {
            transports: ["gateway-relay"],
            inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
            outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
            supportsBargeIn: true,
            handlesInputAudioBargeIn: true,
            supportsToolCalls: true,
          },
          isConfigured: ({ providerConfig }) => Boolean(providerConfig.apiKey),
          createBridge: (req) => ({
            // Set this only if the provider accepts multiple tool responses for
            // one call, for example an immediate "working" response followed by
            // the final result.
            supportsToolResultContinuation: false,
            connect: async () => {},
            sendAudio: () => {},
            setMediaTimestamp: () => {},
            handleBargeIn: () => {},
            submitToolResult: () => {},
            acknowledgeMark: () => {},
            close: () => {},
            isConnected: () => true,
          }),
        });
        ```

        Declare `capabilities` so `talk.catalog` can expose valid modes,
        transports, audio formats, and feature flags to browser and native Talk
        clients. Implement `handleBargeIn` when a transport can detect that a
        human is interrupting assistant playback and the provider supports
        truncating or clearing the active audio response.
        Set `handlesInputAudioBargeIn` only when provider VAD confirms an
        interruption by calling `onClearAudio("barge-in")`. Providers that omit
        the flag use OpenClaw's local input-audio fallback detection.
      </Tab>
      <Tab title="Media understanding">
        ```typescript
        api.registerMediaUnderstandingProvider({
          id: "acme-ai",
          capabilities: ["image", "audio"],
          describeImage: async (req) => ({ text: "A photo of..." }),
          transcribeAudio: async (req) => ({ text: "Transcript..." }),
        });
        ```

        Local or self-hosted media providers that intentionally do not require
        credentials can expose `resolveAuth` and return `kind: "none"`.
        OpenClaw still keeps the normal auth gate for providers that do not
        explicitly opt in. Existing providers can keep reading `req.apiKey`;
        new providers should prefer `req.auth`.

        ```typescript
        api.registerMediaUnderstandingProvider({
          id: "local-audio",
          capabilities: ["audio"],
          resolveAuth: () => ({
            kind: "none",
            source: "local-audio plugin no-auth",
          }),
          transcribeAudio: async (req) => ({ text: "Transcript..." }),
        });
        ```
      </Tab>
      <Tab title="Embeddings">
        ```typescript
        api.registerEmbeddingProvider({
          id: "acme-ai",
          defaultModel: "acme-embed",
          transport: "remote",
          authProviderId: "acme-ai",
          create: async ({ model }) => ({
            provider: {
              id: "acme-ai",
              model,
              dimensions: 1536,
              embed: async (input) => {
                const text = typeof input === "string" ? input : input.text;
                return fetchAcmeEmbedding(text);
              },
              embedBatch: async (inputs) =>
                Promise.all(
                  inputs.map((input) =>
                    fetchAcmeEmbedding(typeof input === "string" ? input : input.text),
                  ),
                ),
            },
          }),
        });
        ```

        Declare the same id in `contracts.embeddingProviders`. This is the
        general embedding contract for reusable vector generation, including
        memory search. `registerMemoryEmbeddingProvider(...)` is deprecated
        compatibility for existing memory-specific adapters.
      </Tab>
      <Tab title="Image and video generation">
        Image and video capabilities use a **mode-aware** shape. Image
        providers declare required `generate` and `edit` capability blocks;
        video providers declare `generate`, `imageToVideo`, and
        `videoToVideo`. Flat aggregate fields like `maxInputImages` /
        `maxInputVideos` / `maxDurationSeconds` are not enough to advertise
        transform-mode support or disabled modes cleanly. Music generation
        follows the same `generate` / `edit` pattern.

        ```typescript
        api.registerImageGenerationProvider({
          id: "acme-ai",
          label: "Acme Images",
          capabilities: {
            generate: { maxCount: 4, supportsSize: true },
            edit: { enabled: false },
          },
          generateImage: async (req) => ({ images: [] }),
        });

        api.registerVideoGenerationProvider({
          id: "acme-ai",
          label: "Acme Video",
          defaultTimeoutMs: 600_000,
          capabilities: {
            generate: { maxVideos: 1, maxDurationSeconds: 10, supportsResolution: true },
            imageToVideo: {
              enabled: true,
              maxVideos: 1,
              maxInputImages: 1,
              maxInputImagesByModel: { "acme/reference-to-video": 9 },
              maxDurationSeconds: 5,
            },
            videoToVideo: { enabled: false },
          },
          generateVideo: async (req) => ({ videos: [] }),
        });
        ```

        `capabilities` is required on both provider types; `edit` and the
        video transform blocks (`imageToVideo`, `videoToVideo`) always need an
        explicit `enabled` flag.
      </Tab>
      <Tab title="Web fetch and search">
        ```typescript
        api.registerWebFetchProvider({
          id: "acme-ai-fetch",
          label: "Acme Fetch",
          hint: "Fetch pages through Acme's rendering backend.",
          envVars: ["ACME_FETCH_API_KEY"],
          placeholder: "acme-...",
          signupUrl: "https://acme.example.com/fetch",
          credentialPath: "plugins.entries.acme.config.webFetch.apiKey",
          getCredentialValue: (fetchConfig) => fetchConfig?.acme?.apiKey,
          setCredentialValue: (fetchConfigTarget, value) => {
            const acme = (fetchConfigTarget.acme ??= {});
            acme.apiKey = value;
          },
          createTool: () => ({
            description: "Fetch a page through Acme Fetch.",
            parameters: {},
            execute: async (args) => ({ content: [] }),
          }),
        });

        api.registerWebSearchProvider({
          id: "acme-ai-search",
          label: "Acme Search",
          hint: "Search the web through Acme's search backend.",
          envVars: ["ACME_SEARCH_API_KEY"],
          placeholder: "acme-...",
          signupUrl: "https://acme.example.com/search",
          credentialPath: "plugins.entries.acme.config.webSearch.apiKey",
          getCredentialValue: (searchConfig) => searchConfig?.acme?.apiKey,
          setCredentialValue: (searchConfigTarget, value) => {
            const acme = (searchConfigTarget.acme ??= {});
            acme.apiKey = value;
          },
          createTool: () => ({
            description: "Search the web through Acme Search.",
            parameters: {},
            execute: async (args) => ({ content: [] }),
          }),
        });
        ```

        Both provider types share the same credential-wiring shape:
        `hint`, `envVars`, `placeholder`, `signupUrl`, `credentialPath`,
        `getCredentialValue`, `setCredentialValue`, and `createTool` are all
        required.
      </Tab>
    </Tabs>

  </Step>

  <Step title="Test">
    ### Step 6: Test

    ```typescript src/provider.test.ts
    import { describe, it, expect } from "vitest";
    // Export your provider config object from index.ts or a dedicated file
    import { acmeProvider } from "./provider.js";

    describe("acme-ai provider", () => {
      it("resolves dynamic models", () => {
        const model = acmeProvider.resolveDynamicModel!({
          modelId: "acme-beta-v3",
        } as any);
        expect(model.id).toBe("acme-beta-v3");
        expect(model.provider).toBe("acme-ai");
      });

      it("returns catalog when key is available", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: "test-key" }),
        } as any);
        expect(result?.provider?.models).toHaveLength(2);
      });

      it("returns null catalog when no key", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        } as any);
        expect(result).toBeNull();
      });
    });
    ```

  </Step>
</Steps>

## Publish to ClawHub

Provider plugins publish the same way as any other external code plugin:

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

`clawhub skill publish <path>` is a different command for publishing a skill
folder, not a plugin package - do not use it here.

## File structure

```
<bundled-plugin-root>/acme-ai/
├── package.json              # openclaw.providers metadata
├── openclaw.plugin.json      # Manifest with provider auth metadata
├── index.ts                  # definePluginEntry + registerProvider
└── src/
    ├── provider.test.ts      # Tests
    └── usage.ts              # Usage endpoint (optional)
```

## Catalog order reference

`catalog.order` controls when your catalog merges relative to built-in
providers:

| Order     | When          | Use case                                        |
| --------- | ------------- | ----------------------------------------------- |
| `simple`  | First pass    | Plain API-key providers                         |
| `profile` | After simple  | Providers gated on auth profiles                |
| `paired`  | After profile | Synthesize multiple related entries             |
| `late`    | Last pass     | Override existing providers (wins on collision) |

## Next steps

- [Channel Plugins](/plugins/sdk-channel-plugins) - if your plugin also provides a channel
- [SDK Runtime](/plugins/sdk-runtime) - `api.runtime` helpers (TTS, search, subagent)
- [SDK Overview](/plugins/sdk-overview) - full subpath import reference
- [Plugin Internals](/plugins/architecture-internals#provider-runtime-hooks) - hook details and bundled examples

## Related

- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
- [Building channel plugins](/plugins/sdk-channel-plugins)
