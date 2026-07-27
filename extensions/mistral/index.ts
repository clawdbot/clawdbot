import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  applyMistralModelCompat,
  MISTRAL_MEDIUM_3_5_ID,
  MISTRAL_SMALL_4_ID,
  MISTRAL_SMALL_LATEST_ID,
} from "./api.js";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { mistralMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { applyMistralConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildMistralProvider } from "./provider-catalog.js";
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
  manifest,
  provider: {
    label: "Mistral",
    docsPath: "/providers/models",
    manifestAuth: { applyConfig: applyMistralConfig },
    catalog: {
      buildProvider: buildMistralProvider,
      buildStaticProvider: buildMistralProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bmistral\b.*(?:input.*too long|token limit.*exceeded)/i.test(errorMessage),
    normalizeResolvedModel: ({ model }) => applyMistralModelCompat(model),
    resolveThinkingProfile: ({ modelId }) =>
      modelId === MISTRAL_SMALL_LATEST_ID ||
      modelId === MISTRAL_SMALL_4_ID ||
      modelId === MISTRAL_MEDIUM_3_5_ID
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
