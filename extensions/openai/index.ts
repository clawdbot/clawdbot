import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { buildOpenAICodexCliBackend } from "./cli-backend.js";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  openaiCodexMediaUnderstandingProvider,
  openaiMediaUnderstandingProvider,
} from "./media-understanding-provider.js";
import { openAiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import {
  resolveOpenAIPromptOverlayMode,
  resolveOpenAISystemPromptContribution,
} from "./prompt-overlay.js";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";
import { buildOpenAIVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    const promptOverlayMode = resolveOpenAIPromptOverlayMode(api.pluginConfig);
    const openAIToolCompatHooks = buildProviderToolCompatFamilyHooks("openai");
    const buildProviderWithPromptContribution = <T extends ReturnType<typeof buildOpenAIProvider>>(
      provider: T,
    ): T => ({
      ...provider,
      ...openAIToolCompatHooks,
      resolveSystemPromptContribution: (ctx) =>
        resolveOpenAISystemPromptContribution({
          mode: promptOverlayMode,
          modelProviderId: provider.id,
          modelId: ctx.modelId,
        }),
    });
    api.registerCliBackend(buildOpenAICodexCliBackend());
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAIProvider()));
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAICodexProviderPlugin()));
    api.registerMemoryEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider());
    api.registerRealtimeVoiceProvider(buildOpenAIRealtimeVoiceProvider());
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
    api.registerMediaUnderstandingProvider(openaiCodexMediaUnderstandingProvider);
    api.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider());
  },
});
