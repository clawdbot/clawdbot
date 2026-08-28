import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
// Moonshot plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { wrapMoonshotStream } from "./native-video.js";
import { applyMoonshotConfig, applyMoonshotConfigCn } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildMoonshotProvider, MOONSHOT_DEFAULT_MODEL_REF } from "./provider-catalog.js";
import {
  isMoonshotAlwaysThinkingModelId,
  isMoonshotK3NativeVideoRoute,
  resolveThinkingProfile,
} from "./provider-policy-api.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";
export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  manifest,
  provider: {
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    aliases: ["moonshotai", "moonshot-ai"],
    manifestAuth: { applyConfig: applyMoonshotConfig },
    extraAuth: [
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key-cn",
        label: "Kimi API key (.cn)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key (.cn)",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: applyMoonshotConfigCn,
        wizard: { groupLabel: "Moonshot AI (Kimi)" },
      }),
    ],
    catalog: {
      buildProvider: buildMoonshotProvider,
      buildStaticProvider: buildMoonshotProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    normalizeResolvedModel: (ctx) =>
      ({
        ...ctx.model,
        input: (ctx.model.input as string[])
          .filter((type) => type !== "video")
          .concat(
            isMoonshotK3NativeVideoRoute({
              ...ctx.model,
              provider: ctx.provider,
              modelId: ctx.modelId,
            })
              ? "video"
              : [],
          ),
      }) as typeof ctx.model,
    buildReplayPolicy: ({ modelApi, modelId }) =>
      buildOpenAICompatibleReplayPolicy(modelApi, {
        modelId,
        sanitizeToolCallIds: modelApi === "openai-completions",
        duplicateToolCallIdStyle: "openai",
        dropReasoningFromHistory: false,
      }),
    wrapStreamFn: (ctx) => wrapMoonshotStream(ctx),
    wrapSimpleCompletionStreamFn: (ctx) => wrapMoonshotStream(ctx, true),
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isMoonshotAlwaysThinkingModelId(modelId),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
