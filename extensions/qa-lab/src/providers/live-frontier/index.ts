import type { QaProviderDefinition } from "../shared/types.js";

function isOpenAiModel(modelRef: string) {
  return modelRef.startsWith("openai/");
}

function isAnthropicModel(modelRef: string) {
  return modelRef.startsWith("anthropic/");
}

function isQaFastModeModelRef(modelRef: string) {
  return isOpenAiModel(modelRef);
}

function isGptFiveModel(modelRef: string) {
  return isOpenAiModel(modelRef) && modelRef.slice("openai/".length).startsWith("gpt-5");
}

function isClaudeOpusModel(modelRef: string) {
  return isAnthropicModel(modelRef) && modelRef.includes("claude-opus");
}

export const liveFrontierProviderDefinition: QaProviderDefinition = {
  mode: "live-frontier",
  kind: "live",
  defaultModel: (options) => options?.preferredLiveModel ?? "openai/gpt-5.5",
  defaultImageGenerationProviderIds: ["openai"],
  defaultImageGenerationModel: ({ modelProviderIds }) =>
    modelProviderIds.includes("openai") ? "openai/gpt-image-1" : null,
  usesFastModeByDefault: isQaFastModeModelRef,
  resolveModelParams: ({ modelRef, fastMode, thinkingDefault }) => ({
    transport: "sse",
    openaiWsWarmup: false,
    ...(fastMode === true || isQaFastModeModelRef(modelRef) ? { fastMode: true } : {}),
    ...(thinkingDefault ? { thinking: thinkingDefault } : {}),
  }),
  resolveTurnTimeoutMs: ({ fallbackMs, modelRef }) => {
    if (isClaudeOpusModel(modelRef)) {
      return Math.max(fallbackMs, 240_000);
    }
    if (isAnthropicModel(modelRef)) {
      return Math.max(fallbackMs, 180_000);
    }
    if (isGptFiveModel(modelRef)) {
      return Math.max(fallbackMs, 360_000);
    }
    return Math.max(fallbackMs, 120_000);
  },
  buildGatewayModels: ({ liveProviderConfigs }) => {
    const providers = liveProviderConfigs ?? {};
    return Object.keys(providers).length > 0
      ? {
          mode: "merge",
          providers,
        }
      : null;
  },
  usesModelProviderPlugins: true,
  scrubsLiveProviderEnv: false,
  appliesLiveEnvAliases: true,
};
