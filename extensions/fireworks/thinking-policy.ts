import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { isFireworksKimiModelId } from "./model-id.js";

const FIREWORKS_KIMI_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

export function resolveFireworksThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  if (!isFireworksKimiModelId(modelId)) {
    return undefined;
  }

  return FIREWORKS_KIMI_THINKING_PROFILE;
}
