type QaLiveTimeoutProfile = {
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
};

function isAnthropicModel(modelRef: string) {
  return modelRef.startsWith("anthropic/");
}

function isOpenAiModel(modelRef: string) {
  return modelRef.startsWith("openai/");
}

function isGptFiveModel(modelRef: string) {
  return isOpenAiModel(modelRef) && modelRef.slice("openai/".length).startsWith("gpt-5");
}

function isClaudeOpusModel(modelRef: string) {
  return isAnthropicModel(modelRef) && modelRef.includes("claude-opus");
}

export function resolveQaLiveTurnTimeoutMs(
  profile: QaLiveTimeoutProfile,
  fallbackMs: number,
  modelRef = profile.primaryModel,
) {
  if (profile.providerMode === "mock-openai") {
    return fallbackMs;
  }
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
}
