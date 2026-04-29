---
summary: "Step-by-step guide to building a model provider plugin for OpenClaw"
title: "Building provider plugins"
sidebarTitle: "Provider plugins"
read_when:
  - You are building a new model provider plugin
  - You want to add an OpenAI-compatible proxy or custom LLM to OpenClaw
  - You need to understand provider auth, catalogs, and runtime hooks
---

This guide walks through building a provider plugin that adds a model provider
(LLM) to OpenClaw. By the end you will have a provider with a model catalog,
API key auth, and dynamic model resolution.

<Info>
  If you have not built any OpenClaw plugin before, read
  [Getting Started](/plugins/building-plugins) first for the basic package
  structure and manifest setup.
</Info>

<Tip>
  Provider plugins add models to OpenClaw's normal inference loop. If the model
  must run through a native agent daemon that owns threads, compaction, or tool
  events, pair the provider with an [agent harness](/plugins/sdk-agent-harness)
  instead of putting daemon protocol details in core.
</Tip>

## Walkthrough

<Steps>
  <Step title="Package and manifest">
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
      "providerAuthEnvVars": {
        "acme-ai": ["ACME_AI_API_KEY"]
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

    The manifest declares `providerAuthEnvVars` so OpenClaw can detect
    credentials without loading your plugin runtime. Add `providerAuthAliases`
    when a provider variant should reuse another provider id's auth. `modelSupport`
    is optional and lets OpenClaw auto-load your provider plugin from shorthand
    model ids like `acme-large` before runtime hooks exist. If you publish the
    provider on ClawHub, those `openclaw.compat` and `openclaw.build` fields
    are required in `package.json`.

  </Step>

  <Step title="Register the provider">
    A minimal provider needs an `id`, `label`, `auth`, and `catalog`:

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
      },
    });
    ```

    That is a working provider. Users can now
    `openclaw onboard --acme-ai-api-key <key>` and select
    `acme-ai/acme-large` as their model.

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
    warm-up — `resolveDynamicModel` runs again after it completes.

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
    | `anthropic-by-model` | Claude-aware replay policy chosen by `modelId`, so Anthropic-message transports only get Claude-specific thinking-block cleanup when the resolved model is actually a Claude id | `amazon-bedrock`, `anthropic-vertex` |
    | `google-gemini` | Native Gemini replay policy plus bootstrap replay sanitation and tagged reasoning-output mode | `google`, `google-gemini-cli` |
    | `passthrough-gemini` | Gemini thought-signature sanitation for Gemini models running through OpenAI-compatible proxy transports; does not enable native Gemini replay validation or bootstrap rewrites | `openrouter`, `kilocode`, `opencode`, `opencode-go` |
    | `hybrid-anthropic-openai` | Hybrid policy for providers that mix Anthropic-message and OpenAI-compatible model surfaces in one plugin; optional Claude-only thinking-block dropping stays scoped to the Anthropic side | `minimax` |

    Available stream families today:

    | Family | What it wires in | Bundled examples |
    | --- | --- | --- |
    | `google-thinking` | Gemini thinking payload normalization on the shared stream path | `google`, `google-gemini-cli` |
    | `kilocode-thinking` | Kilo reasoning wrapper on the shared proxy stream path, with `kilo/auto` and unsupported proxy reasoning ids skipping injected thinking | `kilocode` |
    | `moonshot-thinking` | Moonshot binary native-thinking payload mapping from config + `/think` level | `moonshot` |
    | `minimax-fast-mode` | MiniMax fast-mode model rewrite on the shared stream path | `minimax`, `minimax-portal` |
    | `openai-responses-defaults` | Shared native OpenAI/Codex Responses wrappers: attribution headers, `/fast`/`serviceTier`, text verbosity, native Codex web search, reasoning-compat payload shaping, and Responses context management | `openai`, `openai-codex` |
    | `openrouter-thinking` | OpenRouter reasoning wrapper for proxy routes, with unsupported-model/`auto` skips handled centrally | `openrouter` |
    | `tool-stream-default-on` | Default-on `tool_stream` wrapper for providers like Z.AI that want tool streaming unless explicitly disabled | `zai` |

    <Accordion title="SDK seams powering the family builders">
      Each family builder is composed from lower-level public helpers exported from the same package, which you can reach for when a provider needs to go off the common pattern:

      - `openclaw/plugin-sdk/provider-model-shared` — `ProviderReplayFamily`, `buildProviderReplayFamilyHooks(...)`, and the raw replay builders (`buildOpenAICompatibleReplayPolicy`, `buildAnthropicReplayPolicyForModel`, `buildGoogleGeminiReplayPolicy`, `buildHybridAnthropicOrOpenAIReplayPolicy`). Also exports Gemini replay helpers (`sanitizeGoogleGeminiReplayHistory`, `resolveTaggedReasoningOutputMode`) and endpoint/model helpers (`resolveProviderEndpoint`, `normalizeProviderId`, `normalizeGooglePreviewModelId`, `normalizeNativeXaiModelId`).
      - `openclaw/plugin-sdk/provider-stream` — `ProviderStreamFamily`, `buildProviderStreamFamilyHooks(...)`, `composeProviderStreamWrappers(...)`, plus the shared OpenAI/Codex wrappers (`createOpenAIAttributionHeadersWrapper`, `createOpenAIFastModeWrapper`, `createOpenAIServiceTierWrapper`, `createOpenAIResponsesContextManagementWrapper`, `createCodexNativeWebSearchWrapper`), DeepSeek V4 OpenAI-compatible wrapper (`createDeepSeekV4OpenAICompatibleThinkingWrapper`), Anthropic Messages thinking prefill cleanup (`createAnthropicThinkingPrefillPayloadWrapper`), and shared proxy/provider wrappers (`createOpenRouterWrapper`, `createToolStreamWrapper`, `createMinimaxFastModeWrapper`).
      - `openclaw/plugin-sdk/provider-tools` — `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks("gemini")`, underlying Gemini schema helpers (`normalizeGeminiToolSchemas`, `inspectGeminiToolSchemas`), and xAI compat helpers (`resolveXaiModelCompatPatch()`, `applyXaiModelCompat(model)`). The bundled xAI plugin uses `normalizeResolvedModel` + `contributeResolvedModelCompat` with these to keep xAI rules owned by the provider.

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
      </Tab>
    </Tabs>

    <Accordion title="All available provider hooks">
      OpenClaw calls hooks in this order. Most providers only use 2-3:
      Compatibility-only provider fields that OpenClaw no longer calls, such as
      `ProviderPlugin.capabilities` and `suppressBuiltInModel`, are not listed
      here.

      | # | Hook | When to use |
      | --- | --- | --- |
      | 1 | `catalog` | Model catalog or base URL defaults |
      | 2 | `applyConfigDefaults` | Provider-owned global defaults during config materialization |
      | 3 | `normalizeModelId` | Legacy/preview model-id alias cleanup before lookup |
      | 4 | `normalizeTransport` | Provider-family `api` / `baseUrl` cleanup before generic model assembly |
      | 5 | `normalizeConfig` | Normalize `models.providers.<id>` config |
      | 6 | `applyNativeStreamingUsageCompat` | Native streaming-usage compat rewrites for config providers |
      | 7 | `resolveConfigApiKey` | Provider-owned env-marker auth resolution |
      | 8 | `resolveSyntheticAuth` | Local/self-hosted or config-backed synthetic auth |
      | 9 | `shouldDeferSyntheticProfileAuth` | Lower synthetic stored-profile placeholders behind env/config auth |
      | 10 | `resolveDynamicModel` | Accept arbitrary upstream model IDs |
      | 11 | `prepareDynamicModel` | Async metadata fetch before resolving |
      | 12 | `normalizeResolvedModel` | Transport rewrites before the runner |
      | 13 | `contributeResolvedModelCompat` | Compat flags for vendor models behind another compatible transport |
      | 14 | `normalizeToolSchemas` | Provider-owned tool-schema cleanup before registration |
      | 15 | `inspectToolSchemas` | Provider-owned tool-schema diagnostics |
      | 16 | `resolveReasoningOutputMode` | Tagged vs native reasoning-output contract |
      | 17 | `prepareExtraParams` | Default request params |
      | 18 | `createStreamFn` | Fully custom StreamFn transport |
      | 19 | `wrapStreamFn` | Custom headers/body wrappers on the normal stream path |
      | 20 | `resolveTransportTurnState` | Native per-turn headers/metadata |
      | 21 | `resolveWebSocketSessionPolicy` | Native WS session headers/cool-down |
      | 22 | `formatApiKey` | Custom runtime token shape |
      | 23 | `refreshOAuth` | Custom OAuth refresh |
      | 24 | `buildAuthDoctorHint` | Auth repair guidance |
      | 25 | `matchesContextOverflowError` | Provider-owned overflow detection |
      | 26 | `classifyFailoverReason` | Provider-owned rate-limit/overload classification |
      | 27 | `isCacheTtlEligible` | Prompt cache TTL gating |
      | 28 | `buildMissingAuthMessage` | Custom missing-auth hint |
      | 29 | `augmentModelCatalog` | Synthetic forward-compat rows |
      | 30 | `resolveThinkingProfile` | Model-specific `/think` option set |
      | 31 | `isBinaryThinking` | Binary thinking on/off compatibility |
      | 32 | `supportsXHighThinking` | `xhigh` reasoning support compatibility |
      | 33 | `resolveDefaultThinkingLevel` | Default `/think` policy compatibility |
      | 34 | `isModernModelRef` | Live/smoke model matching |
      | 35 | `prepareRuntimeAuth` | Token exchange before inference |
      | 36 | `resolveUsageAuth` | Custom usage credential parsing |
      | 37 | `fetchUsageSnapshot` | Custom usage endpoint |
      | 38 | `createEmbeddingProvider` | Provider-owned embedding adapter for memory/search |
      | 39 | `buildReplayPolicy` | Custom transcript replay/compaction policy |
      | 40 | `sanitizeReplayHistory` | Provider-specific replay rewrites after generic cleanup |
      | 41 | `validateReplayTurns` | Strict replay-turn validation before the embedded runner |
      | 42 | `onModelSelected` | Post-selection callback (e.g. telemetry) |

      Runtime fallback notes:

      - `normalizeConfig` checks the matched provider first, then other hook-capable provider plugins until one actually changes the config. If no provider hook rewrites a supported Google-family config entry, the bundled Google config normalizer still applies.
      - `resolveConfigApiKey` uses the provider hook when exposed. The bundled `amazon-bedrock` path also has a built-in AWS env-marker resolver here, even though Bedrock runtime auth itself still uses the AWS SDK default chain.
      - `resolveSystemPromptContribution` lets a provider inject cache-aware system-prompt guidance for a model family. Prefer it over `before_prompt_build` when the behavior belongs to one provider/model family and should preserve the stable/dynamic cache split.

      For detailed descriptions and real-world examples, see [Internals: Provider Runtime Hooks](/plugins/architecture-internals#provider-runtime-hooks).
    </Accordion>

  </Step>

  <Step title="Add extra capabilities (optional)">
    A provider plugin can register speech, realtime transcription, realtime
    voice, media understanding, image generation, video generation, web fetch,
    and web search alongside text inference. OpenClaw classifies this as a
    **hybrid-capability** plugin — the recommended pattern for company plugins
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
        Prefer `createRealtimeTranscriptionWebSocketSession(...)` — the shared
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
          isConfigured: ({ providerConfig }) => Boolean(providerConfig.apiKey),
          createBridge: (req) => ({
            // Set this only if the provider accepts multiple tool responses for
            // one call, for example an immediate "working" response followed by
            // the final result.
            supportsToolResultContinuation: false,
            connect: async () => {},
            sendAudio: () => {},
            setMediaTimestamp: () => {},
            submitToolResult: () => {},
            acknowledgeMark: () => {},
            close: () => {},
            isConnected: () => true,
          }),
        });
        ```
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
      </Tab>
      <Tab title="Image and video generation">
        Video capabilities use a **mode-aware** shape: `generate`,
        `imageToVideo`, and `videoToVideo`. Flat aggregate fields like
        `maxInputImages` / `maxInputVideos` / `maxDurationSeconds` are not
        enough to advertise transform-mode support or disabled modes cleanly.
        Music generation follows the same pattern with explicit `generate` /
        `edit` blocks.

        ```typescript
        api.registerImageGenerationProvider({
          id: "acme-ai",
          label: "Acme Images",
          generate: async (req) => ({ /* image result */ }),
        });

        api.registerVideoGenerationProvider({
          id: "acme-ai",
          label: "Acme Video",
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
          search: async (req) => ({ content: [] }),
        });
        ```
      </Tab>
    </Tabs>

  </Step>

  <Step title="Test">
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

Do not use the legacy skill-only publish alias here; plugin packages should use
`clawhub package publish`.

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

- [Channel Plugins](/plugins/sdk-channel-plugins) — if your plugin also provides a channel
- [SDK Runtime](/plugins/sdk-runtime) — `api.runtime` helpers (TTS, search, subagent)
- [SDK Overview](/plugins/sdk-overview) — full subpath import reference
- [Plugin Internals](/plugins/architecture-internals#provider-runtime-hooks) — hook details and bundled examples

## Related

- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
- [Building channel plugins](/plugins/sdk-channel-plugins)
