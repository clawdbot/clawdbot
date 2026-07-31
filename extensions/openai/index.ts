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

// The GPT-Live browser broker is process-wide shared state. Reuse one broker
// across repeated full OpenAI plugin registrations so reservation and offer
// state stay together; only disable tears it down and allows the next full
// registration to create a fresh one (#116525).
type QuicksilverSession = ReturnType<typeof createOpenAIQuicksilverBrowserSessionBroker>;
let sharedQuicksilverSession: QuicksilverSession | undefined;

/** Test-only: drop the shared broker so repeated-registration tests start clean. */
export function resetSharedQuicksilverSessionForTests(): void {
  sharedQuicksilverSession = undefined;
}

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    const quicksilverSession =
      api.registrationMode === "full"
        ? (sharedQuicksilverSession ??
          (sharedQuicksilverSession = createOpenAIQuicksilverBrowserSessionBroker({
            getConfig: () => api.runtime.config.current() as OpenClawConfig,
            logger: api.logger,
          })))
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
        cleanup: (ctx) => {
          // The broker is process-wide shared state; only tear it down when the
          // OpenAI plugin itself is disabled. host-hook-cleanup.ts invokes this
          // callback for every reason (including unrelated session reset/delete/
          // restart), and cleanup() permanently stops the broker for the whole
          // process, so session cleanup must not trigger it (#116525).
          if (ctx.reason === "disable") {
            const session = sharedQuicksilverSession;
            sharedQuicksilverSession = undefined;
            return session?.cleanup();
          }
          return undefined;
        },
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
