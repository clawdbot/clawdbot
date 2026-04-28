import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";
import { deepinfraMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { deepinfraMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { applyDeepInfraConfig } from "./onboard.js";
import { buildDeepInfraProvider, buildStaticDeepInfraProvider } from "./provider-catalog.js";
import { DEEPINFRA_DEFAULT_MODEL_REF } from "./provider-models.js";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";
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
      buildProvider: buildDeepInfraProvider,
      buildStaticProvider: buildStaticDeepInfraProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    normalizeConfig: ({ providerConfig }) => providerConfig,
    normalizeTransport: ({ api, baseUrl }) =>
      baseUrl === "https://api.deepinfra.com/v1/openai" ? { api, baseUrl } : undefined,
    ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
    wrapStreamFn: (ctx) => {
      const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel;
      return createOpenRouterSystemCacheWrapper(
        createOpenRouterWrapper(ctx.streamFn, thinkingLevel),
      );
    },
    isModernModelRef: () => true,
    isCacheTtlEligible: (ctx) => ctx.modelId.toLowerCase().startsWith("anthropic/"),
  },
  register(api) {
    api.registerImageGenerationProvider(buildDeepInfraImageGenerationProvider());
    api.registerMediaUnderstandingProvider(deepinfraMediaUnderstandingProvider);
    api.registerMemoryEmbeddingProvider(deepinfraMemoryEmbeddingProviderAdapter);
    api.registerSpeechProvider(buildDeepInfraSpeechProvider());
    api.registerVideoGenerationProvider(buildDeepInfraVideoGenerationProvider());
  },
});
