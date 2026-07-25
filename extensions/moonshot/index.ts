// Moonshot plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { applyMoonshotNativeStreamingUsageCompat } from "./api.js";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildMoonshotProvider } from "./provider-catalog.js";
import { isMoonshotAlwaysThinkingModelId, resolveThinkingProfile } from "./provider-policy-api.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";
const moonshotThinkingStreamHooks = buildProviderStreamFamilyHooks("moonshot-thinking");

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  provider: {
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    aliases: ["moonshotai", "moonshot-ai"],
    auth: [
      {
        methodId: "api-key",
        label: "Kimi API key (.ai)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfig(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
      {
        methodId: "api-key-cn",
        label: "Kimi API key (.cn)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key (.cn)",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
    ],
    catalog: {
      buildProvider: buildMoonshotProvider,
      buildStaticProvider: buildMoonshotProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyMoonshotNativeStreamingUsageCompat(providerConfig),
    buildReplayPolicy: ({ modelApi, modelId }) =>
      buildOpenAICompatibleReplayPolicy(modelApi, {
        modelId,
        sanitizeToolCallIds: modelApi === "openai-completions",
        duplicateToolCallIdStyle: "openai",
        dropReasoningFromHistory: false,
      }),
    ...moonshotThinkingStreamHooks,
    wrapSimpleCompletionStreamFn: (ctx) =>
      isMoonshotAlwaysThinkingModelId(ctx.modelId)
        ? moonshotThinkingStreamHooks.wrapStreamFn?.(ctx)
        : ctx.streamFn,
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isMoonshotAlwaysThinkingModelId(modelId),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
