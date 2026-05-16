import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const MIMO_REASONING_MODEL_IDS = new Set([
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-pro",
]);

export function isMiMoReasoningModelId(modelId: string): boolean {
  return MIMO_REASONING_MODEL_IDS.has(modelId.toLowerCase());
}

export function isMiMoReasoningModelRef(model: { provider?: string; id?: unknown }): boolean {
  return (
    model.provider === "xiaomi" && typeof model.id === "string" && isMiMoReasoningModelId(model.id)
  );
}

const MIMO_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const MIMO_THINKING_PROFILE = {
  levels: MIMO_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveMiMoThinkingProfile(modelId: string): ProviderThinkingProfile | undefined {
  return isMiMoReasoningModelId(modelId) ? MIMO_THINKING_PROFILE : undefined;
}
