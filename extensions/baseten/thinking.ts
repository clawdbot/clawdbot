/** Baseten model-specific thinking controls. */
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { usesBasetenChatTemplateThinking } from "./models.js";

const BASETEN_BINARY_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low", label: "on" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

const BASETEN_GLM_52_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

/** Exposes only the thinking levels that Baseten actually accepts for opt-in models. */
export function resolveBasetenThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "zai-org/glm-5.2") {
    return BASETEN_GLM_52_THINKING_PROFILE;
  }
  return usesBasetenChatTemplateThinking(normalized) ? BASETEN_BINARY_THINKING_PROFILE : undefined;
}
