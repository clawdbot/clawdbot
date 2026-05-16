import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { PROVIDER_LABELS } from "openclaw/plugin-sdk/provider-usage";
import { applyXiaomiConfig, XIAOMI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildXiaomiProvider } from "./provider-catalog.js";
import { buildXiaomiSpeechProvider } from "./speech-provider.js";
import { createMiMoThinkingWrapper } from "./stream.js";
import { resolveMiMoThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "xiaomi";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Xiaomi Provider",
  description: "Bundled Xiaomi provider plugin",
  provider: {
    label: "Xiaomi",
    docsPath: "/providers/xiaomi",
    auth: [
      {
        methodId: "api-key",
        label: "Xiaomi API key",
        hint: "API key",
        optionKey: "xiaomiApiKey",
        flagName: "--xiaomi-api-key",
        envVar: "XIAOMI_API_KEY",
        promptMessage: "Enter Xiaomi API key",
        defaultModel: XIAOMI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyXiaomiConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildXiaomiProvider,
    },
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    wrapStreamFn: (ctx) => createMiMoThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
    resolveThinkingProfile: ({ modelId }) => resolveMiMoThinkingProfile(modelId),
    isModernModelRef: ({ modelId }) => Boolean(resolveMiMoThinkingProfile(modelId)),
    resolveUsageAuth: async (ctx) => {
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        envDirect: [ctx.env.XIAOMI_API_KEY],
      });
      return apiKey ? { token: apiKey } : null;
    },
    fetchUsageSnapshot: async () => ({
      provider: "xiaomi",
      displayName: PROVIDER_LABELS.xiaomi,
      windows: [],
    }),
  },
  register(api) {
    api.registerSpeechProvider(buildXiaomiSpeechProvider());
  },
});
