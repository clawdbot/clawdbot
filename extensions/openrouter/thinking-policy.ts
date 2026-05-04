import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { isOpenRouterDeepSeekV4ModelId } from "./models.js";

const OPENROUTER_DEEPSEEK_V4_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function buildOpenRouterDeepSeekV4ThinkingLevel(
  id: (typeof OPENROUTER_DEEPSEEK_V4_THINKING_LEVEL_IDS)[number],
) {
  return { id };
}

const OPENROUTER_DEEPSEEK_V4_THINKING_PROFILE = {
  levels: OPENROUTER_DEEPSEEK_V4_THINKING_LEVEL_IDS.map(buildOpenRouterDeepSeekV4ThinkingLevel),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function supportsOpenRouterXHighThinking(modelId: string): boolean {
  return isOpenRouterDeepSeekV4ModelId(modelId);
}

export function resolveOpenRouterThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isOpenRouterDeepSeekV4ModelId(modelId)
    ? OPENROUTER_DEEPSEEK_V4_THINKING_PROFILE
    : undefined;
}
