import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyDeepSeekConfig, DEEPSEEK_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";
import { createDeepSeekV4ThinkingWrapper } from "./stream.js";
import { resolveDeepSeekV4ThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "deepseek";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DeepSeek Provider",
  description: "Bundled DeepSeek provider plugin",
  provider: {
    label: "DeepSeek",
    docsPath: "/providers/deepseek",
    auth: [
      {
        methodId: "api-key",
        label: "DeepSeek API key",
        hint: "API key",
        optionKey: "deepseekApiKey",
        flagName: "--deepseek-api-key",
        envVar: "DEEPSEEK_API_KEY",
        promptMessage: "Enter DeepSeek API key",
        defaultModel: DEEPSEEK_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDeepSeekConfig(cfg),
        wizard: {
          choiceId: "deepseek-api-key",
          choiceLabel: "DeepSeek API key",
          groupId: "deepseek",
          groupLabel: "DeepSeek",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildDeepSeekProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bdeepseek\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    wrapStreamFn: (ctx) => createDeepSeekV4ThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
    resolveThinkingProfile: ({ modelId }) => resolveDeepSeekV4ThinkingProfile(modelId),
    isModernModelRef: ({ modelId }) => Boolean(resolveDeepSeekV4ThinkingProfile(modelId)),
  },
});
