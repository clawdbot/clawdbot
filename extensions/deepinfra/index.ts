import {
  type ProviderCatalogContext,
  type ConfiguredProviderCatalogEntry,
  readConfiguredProviderCatalogEntries,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { createDeepInfraAnthropicCacheWrapper } from "./cache-wrapper.js";
import { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";
import { buildDeepInfraMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildDeepInfraMemoryEmbeddingAdapter } from "./memory-embedding-adapter.js";
import { applyDeepInfraConfig } from "./onboard.js";
import { buildDeepInfraApiKeyCatalog, buildStaticDeepInfraProvider } from "./provider-catalog.js";
import {
  DEEPINFRA_DEFAULT_MODEL_REF,
  discoverDeepInfraModels,
  getDeepInfraSurfaceFallbackCatalog,
  hasDeepInfraApiKey,
} from "./provider-models.js";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";
import {
  listDeepInfraImageGenCatalog,
  listDeepInfraVideoGenCatalog,
} from "./surface-model-catalogs.js";
import { buildDeepInfraVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "deepinfra";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DeepInfra Provider",
  description: "Bundled DeepInfra provider plugin",
  provider: {
    label: "DeepInfra",
    docsPath: "/providers/deepinfra",
    auth: [
      {
        methodId: "api-key",
        label: "DeepInfra API key",
        hint: "Unified API for open source models",
        optionKey: "deepinfraApiKey",
        flagName: "--deepinfra-api-key",
        envVar: "DEEPINFRA_API_KEY",
        promptMessage: "Enter DeepInfra API key",
        noteTitle: "DeepInfra",
        noteMessage: [
          "DeepInfra provides an OpenAI-compatible API for open source and frontier models.",
          "Get your API key at: https://deepinfra.com/dash/api_keys",
        ].join("\n"),
        defaultModel: DEEPINFRA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDeepInfraConfig(cfg),
        wizard: {
          choiceId: "deepinfra-api-key",
          choiceLabel: "DeepInfra API key",
          choiceHint: "Unified API for open source models",
          groupId: PROVIDER_ID,
          groupLabel: "DeepInfra",
          groupHint: "Unified API for open source models",
        },
      },
    ],
    catalog: {
      order: "simple",
      run: (ctx: ProviderCatalogContext) => buildDeepInfraApiKeyCatalog(ctx),
      staticRun: async () => ({ provider: buildStaticDeepInfraProvider() }),
    },
    augmentModelCatalog: async ({ config, env, agentDir }) => {
      const configured = readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      });
      // Gate dynamic discovery on the user having configured a DeepInfra API
      // key (env var, config SecretInput, or auth-profile store).
      // Pre-auth flows keep the curated manifest fallback so the model picker
      // stays tight and startup stays offline-friendly.
      const hasApiKey = hasDeepInfraApiKey({ env, agentDir, config });
      const seen = new Set(configured.map((entry) => entry.id));
      const discovered = await discoverDeepInfraModels({ hasApiKey, env, agentDir });
      const merged: ConfiguredProviderCatalogEntry[] = [...configured];
      for (const model of discovered) {
        if (seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);
        const input = model.input;
        merged.push({
          provider: PROVIDER_ID,
          id: model.id,
          name: model.name ?? model.id,
          ...(typeof model.contextWindow === "number" && model.contextWindow > 0
            ? { contextWindow: model.contextWindow }
            : {}),
          ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
          ...(input && input.length > 0 ? { input } : {}),
        });
      }
      return merged;
    },
    normalizeConfig: ({ providerConfig }) => providerConfig,
    normalizeTransport: ({ api, baseUrl }) =>
      baseUrl === "https://api.deepinfra.com/v1/openai" ? { api, baseUrl } : undefined,
    ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
    wrapStreamFn: (ctx) => {
      const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel;
      // OpenRouter wrapper handles reasoning normalization for proxy-style
      // providers; layer DeepInfra's anthropic cache-marker wrapper on top so
      // anthropic/* requests carry the ephemeral cache_control markers that
      // the upstream OpenRouter-only wrapper skips.
      return createDeepInfraAnthropicCacheWrapper(
        createOpenRouterWrapper(ctx.streamFn, thinkingLevel),
      );
    },
    isModernModelRef: () => true,
    isCacheTtlEligible: (ctx) => ctx.modelId.toLowerCase().startsWith("anthropic/"),
  },
  register(api) {
    // Single source for media defaults at register time; image-gen and
    // video-gen also get a live registerModelCatalogProvider that refreshes
    // from the agent endpoint when a key is configured (OpenRouter pattern).
    // TTS/STT/VLM/embed stay static until UnifiedModelCatalogKind covers them.
    const catalog = getDeepInfraSurfaceFallbackCatalog();
    api.registerImageGenerationProvider(
      buildDeepInfraImageGenerationProvider({ imageGenModels: catalog.imageGen }),
    );
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["image_generation"],
      liveCatalog: listDeepInfraImageGenCatalog,
    });
    api.registerMediaUnderstandingProvider(
      buildDeepInfraMediaUnderstandingProvider({
        vlmModels: catalog.vlm,
        sttModels: catalog.stt,
      }),
    );
    api.registerMemoryEmbeddingProvider(
      buildDeepInfraMemoryEmbeddingAdapter({ embedModels: catalog.embed }),
    );
    api.registerSpeechProvider(buildDeepInfraSpeechProvider({ ttsModels: catalog.tts }));
    api.registerVideoGenerationProvider(
      buildDeepInfraVideoGenerationProvider({ videoGenModels: catalog.videoGen }),
    );
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["video_generation"],
      liveCatalog: listDeepInfraVideoGenCatalog,
    });
  },
});
