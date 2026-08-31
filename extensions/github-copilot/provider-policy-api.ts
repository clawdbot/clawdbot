// Github Copilot API module exposes the plugin public contract.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import { resolveCopilotThinkingLevelMap } from "./model-metadata.js";

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  if (context.provider.trim().toLowerCase() !== "github-copilot") {
    return null;
  }
  const thinkingLevelMap = resolveCopilotThinkingLevelMap(
    context.modelId,
    context.compat,
    context.api,
  );
  const extendedLevels = (["xhigh", "max"] as const).filter((id) => thinkingLevelMap?.[id]);

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
