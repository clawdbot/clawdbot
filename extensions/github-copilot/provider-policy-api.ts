// Github Copilot API module exposes the plugin public contract.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import { resolveCopilotExtendedThinkingLevels } from "./model-metadata.js";

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  if (context.provider.trim().toLowerCase() !== "github-copilot") {
    return null;
  }
  const extendedLevels = resolveCopilotExtendedThinkingLevels(context.modelId, context.compat);

  return {
    levels: [
      { id: "off" as const },
      { id: "minimal" as const },
      { id: "low" as const },
      { id: "medium" as const },
      { id: "high" as const },
      ...extendedLevels.map((id) => ({ id })),
    ],
  };
}
