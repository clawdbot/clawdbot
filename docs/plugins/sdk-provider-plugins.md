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

    For provider-key lookup and selection from an already loaded auth store,
    import `findNormalizedProviderValue` and `resolveAuthProfileOrder` from
    `openclaw/plugin-sdk/provider-auth`. This keeps provider entrypoints from
    loading the full agent runtime just to select a credential. The deprecated
    `agent-runtime` exports remain available for compatibility; use the narrower
    `provider-auth` route in new code.

    A custom interactive auth method that mints a static token or API key can
    request protected persistence on its returned profile:

    ```typescript
    return {
      profiles: [
        {
          profileId: "acme-ai:device",
          credential: { type: "token", provider: "acme-ai", token },
          secretStorage: {
            kind: "store",
            namePrefix: "ACME_AI_TOKEN",
          },
        },
      ],
    };
    ```

    OpenClaw keeps the inline value only while staged validation runs. At the
    final persistence boundary it writes the value to the protected local store
    and saves a `tokenRef` or `keyRef` in the auth profile. `namePrefix` must be
    an uppercase environment-style name. OpenClaw adds a stable suffix derived
    from the provider and final profile id so multiple profiles remain separate.
    Use this only for provider-minted static credentials, not rotating OAuth
    credentials or values already supplied as SecretRefs.

    For live `/models` discovery, catalog helpers, pricing normalization, and
    the narrower single-provider entry point, see [Provider model
    catalogs](/plugins/sdk-provider-plugins/model-catalogs).

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

    If resolving requires a network call, return the requested model directly
    from `prepareDynamicModel`. OpenClaw applies the same configured overrides
    and normalization as synchronous dynamic resolution. Existing hooks that
    return nothing still retry `resolveDynamicModel` after preparation.

  </Step>

  <Step title="Add runtime hooks (as needed)">
    Most providers only need `catalog` + `resolveDynamicModel`. Add hooks
    incrementally as your provider requires them.

    Start with the shared family builders in [Provider hook
    families](/plugins/sdk-provider-plugins/hook-families), then wire individual
    hooks with [Provider hook wiring](/plugins/sdk-provider-plugins/runtime-hooks).

  </Step>

  <Step title="Add extra capabilities (optional)">
    ### Step 5: Add extra capabilities

    A provider plugin can register embeddings, speech, realtime transcription,
    realtime voice, media understanding, image generation, video generation,
    web fetch, and web search alongside text inference. OpenClaw classifies this as a
    **hybrid-capability** plugin - the recommended pattern for company plugins
    (one plugin per vendor). See
    [Internals: Capability Ownership](/plugins/architecture#capability-ownership-model).

    Register the audio capabilities from [Provider voice
    capabilities](/plugins/sdk-provider-plugins/voice-and-audio); register
    embeddings, generation, fetch, and search from [Provider media and
    search](/plugins/sdk-provider-plugins/media-and-search).

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

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the five child pages below. The anchors from the single-page version still
resolve here.

### Provider model catalogs

[Provider model catalogs](/plugins/sdk-provider-plugins/model-catalogs) — Live model discovery, catalog helpers, pricing normalization, and the single-provider entry helper.

- <a id="live-model-discovery"></a>[Live model discovery](/plugins/sdk-provider-plugins/model-catalogs#live-model-discovery)

### Provider hook families

[Provider hook families](/plugins/sdk-provider-plugins/hook-families) — Shared replay, stream, and tool-compat family builders and the SDK seams behind them.

- <a id="sdk-seams-powering-the-family-builders"></a>[SDK seams powering the family builders](/plugins/sdk-provider-plugins/hook-families#sdk-seams-powering-the-family-builders)

### Provider hook wiring

[Provider hook wiring](/plugins/sdk-provider-plugins/runtime-hooks) — Per-hook wiring for auth exchange, headers, transport identity, usage, and the hook order table.

- <a id="token-exchange"></a>[Token exchange](/plugins/sdk-provider-plugins/runtime-hooks#token-exchange)
- <a id="custom-headers"></a>[Custom headers](/plugins/sdk-provider-plugins/runtime-hooks#custom-headers)
- <a id="native-transport-identity"></a>[Native transport identity](/plugins/sdk-provider-plugins/runtime-hooks#native-transport-identity)
- <a id="usage-and-billing"></a>[Usage and billing](/plugins/sdk-provider-plugins/runtime-hooks#usage-and-billing)
- <a id="common-provider-hooks"></a>[Common provider hooks](/plugins/sdk-provider-plugins/runtime-hooks#common-provider-hooks)

### Provider voice capabilities

[Provider voice capabilities](/plugins/sdk-provider-plugins/voice-and-audio) — Speech, realtime transcription, realtime voice, and media understanding capabilities.

- <a id="speech-tts"></a>[Speech (TTS)](/plugins/sdk-provider-plugins/voice-and-audio#speech-tts)
- <a id="realtime-transcription"></a>[Realtime transcription](/plugins/sdk-provider-plugins/voice-and-audio#realtime-transcription)
- <a id="realtime-voice"></a>[Realtime voice](/plugins/sdk-provider-plugins/voice-and-audio#realtime-voice)
- <a id="media-understanding"></a>[Media understanding](/plugins/sdk-provider-plugins/voice-and-audio#media-understanding)

### Provider media and search

[Provider media and search](/plugins/sdk-provider-plugins/media-and-search) — Embeddings, image and video generation, web fetch, and web search capabilities.

- <a id="embeddings"></a>[Embeddings](/plugins/sdk-provider-plugins/media-and-search#embeddings)
- <a id="image-and-video-generation"></a>[Image and video generation](/plugins/sdk-provider-plugins/media-and-search#image-and-video-generation)
- <a id="web-fetch-and-search"></a>[Web fetch and search](/plugins/sdk-provider-plugins/media-and-search#web-fetch-and-search)

## Related

- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
- [Building channel plugins](/plugins/sdk-channel-plugins)
