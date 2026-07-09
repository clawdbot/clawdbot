// Meta plugin module implements thinking behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const META_REASONING_MODEL_IDS = new Set(["muse-spark", "muse-spark-1.1"]);

function isMetaReasoningModelId(modelId: string): boolean {
  return META_REASONING_MODEL_IDS.has(modelId.toLowerCase());
}

const META_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const META_THINKING_PROFILE = {
  levels: META_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveMetaThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isMetaReasoningModelId(modelId) ? META_THINKING_PROFILE : undefined;
}
