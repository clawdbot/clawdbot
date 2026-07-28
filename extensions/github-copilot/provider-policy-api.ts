// Github Copilot API module exposes the plugin public contract.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/core";
import { resolveClaudeThinkingProfile } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCopilotExtendedThinkingLevels } from "./model-metadata.js";

function isCopilotClaudeAnthropicMessagesModel({
  api,
  modelId,
}: ProviderDefaultThinkingPolicyContext): boolean {
  return api === "anthropic-messages" && modelId.trim().toLowerCase().includes("claude");
}

export function resolveThinkingProfile(
  context: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | null {
  if (context.provider.trim().toLowerCase() !== "github-copilot") {
    return null;
  }
  if (isCopilotClaudeAnthropicMessagesModel(context)) {
    return {
      ...resolveClaudeThinkingProfile(context.modelId, context.params, { includeNativeMax: true }),
      preserveWhenCatalogReasoningFalse: true,
    };
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
