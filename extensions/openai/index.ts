// Openai plugin entrypoint registers its OpenClaw integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { openAiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import {
  resolveOpenAIPromptOverlayMode,
  resolveOpenAISystemPromptContribution,
} from "./prompt-overlay.js";
import {
  createOpenAIQuicksilverBrowserSessionBroker,
  OPENAI_QUICKSILVER_OFFER_PATH,
} from "./realtime-quicksilver-session.js";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";
import { buildOpenAIVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    const quicksilverSession =
      api.registrationMode === "full"
        ? createOpenAIQuicksilverBrowserSessionBroker({
            getConfig: () => api.runtime.config.current() as OpenClawConfig,
            logger: api.logger,
          })
        : undefined;
    if (quicksilverSession) {
      api.registerHttpRoute({
        path: OPENAI_QUICKSILVER_OFFER_PATH,
        auth: "plugin",
        match: "exact",
        handler: quicksilverSession.handler,
      });
      api.lifecycle.registerRuntimeLifecycle({
        id: "openai-quicksilver-realtime-browser-session",
        description: "Close GPT-Live browser sidebands when the OpenAI plugin stops",
        cleanup: () => quicksilverSession.cleanup(),
      });
    }
    const openAIToolCompatHooks = buildProviderToolCompatFamilyHooks("openai");
    const buildProviderWithPromptContribution = <T extends ReturnType<typeof buildOpenAIProvider>>(
      provider: T,
    ): T => ({
      ...provider,
      ...openAIToolCompatHooks,
      resolveSystemPromptContribution: (ctx) => {
        const runtimePluginConfig = resolvePluginConfigObject(ctx.config, "openai");
        const pluginConfig =
          runtimePluginConfig ??
          (ctx.config ? undefined : (api.pluginConfig as Record<string, unknown>));
        return resolveOpenAISystemPromptContribution({
          config: ctx.config,
          legacyPluginConfig: pluginConfig,
          mode: resolveOpenAIPromptOverlayMode(pluginConfig),
          modelProviderId: provider.id,
          modelId: ctx.modelId,
          trigger: ctx.trigger,
        });
      },
    });
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAIProvider()));
    api.registerMemoryEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider());
    api.registerRealtimeVoiceProvider(
      buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: quicksilverSession?.broker,
        logger: api.logger,
      }),
    );
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
    api.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider());
  },
});
