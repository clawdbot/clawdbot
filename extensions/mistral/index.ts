import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyMistralModelCompat, MISTRAL_SMALL_LATEST_ID, MISTRAL_MEDIUM_3_5_ID } from "./api.js";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { mistralMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { applyMistralConfig, MISTRAL_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMistralProvider } from "./provider-catalog.js";
import { contributeMistralResolvedModelCompat } from "./provider-compat.js";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const PROVIDER_ID = "mistral";
function buildMistralReplayPolicy() {
  return {
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict9" as const,
  };
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Mistral Provider",
  description: "Bundled Mistral provider plugin",
  provider: {
    label: "Mistral",
    docsPath: "/providers/models",
    auth: [
      {
        methodId: "api-key",
        label: "Mistral API key",
        hint: "API key",
        optionKey: "mistralApiKey",
        flagName: "--mistral-api-key",
        envVar: "MISTRAL_API_KEY",
        promptMessage: "Enter Mistral API key",
        defaultModel: MISTRAL_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMistralConfig(cfg),
        wizard: {
          groupLabel: "Mistral AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildMistralProvider,
      allowExplicitBaseUrl: true,
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bmistral\b.*(?:input.*too long|token limit.*exceeded)/i.test(errorMessage),
    normalizeResolvedModel: ({ model }) => applyMistralModelCompat(model),
    contributeResolvedModelCompat: ({ modelId, model }) =>
      contributeMistralResolvedModelCompat({ modelId, model }),
    resolveThinkingProfile: ({ modelId }) =>
      modelId === MISTRAL_SMALL_LATEST_ID || modelId === MISTRAL_MEDIUM_3_5_ID
        ? { levels: [{ id: "off" }, { id: "high" }], defaultLevel: "off" }
        : undefined,
    buildReplayPolicy: () => buildMistralReplayPolicy(),
  },
  register(api) {
    api.registerMemoryEmbeddingProvider(mistralMemoryEmbeddingProviderAdapter);
    api.registerMediaUnderstandingProvider(mistralMediaUnderstandingProvider);
    api.registerRealtimeTranscriptionProvider(buildMistralRealtimeTranscriptionProvider());
  },
});
