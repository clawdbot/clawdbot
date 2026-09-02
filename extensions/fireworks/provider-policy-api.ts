// Fireworks API module exposes the plugin public contract.
import { resolveFireworksThinkingProfile } from "./thinking-policy.js";

export function resolveThinkingProfile(params: {
  provider?: string;
  modelId: string;
}): ReturnType<typeof resolveFireworksThinkingProfile> {
  return resolveFireworksThinkingProfile(params.modelId);
}
