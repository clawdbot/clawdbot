import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { isDeepSeekV4ModelId } from "./models.js";

const V4_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function buildDeepSeekV4ThinkingLevel(id: (typeof V4_THINKING_LEVEL_IDS)[number]) {
  return { id };
}

const DEEPSEEK_V4_THINKING_PROFILE = {
  levels: V4_THINKING_LEVEL_IDS.map(buildDeepSeekV4ThinkingLevel),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveDeepSeekV4ThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isDeepSeekV4ModelId(modelId) ? DEEPSEEK_V4_THINKING_PROFILE : undefined;
}
