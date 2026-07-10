import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
// Openai API module exposes the plugin public contract.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}

export function resolveThinkingProfile(params: ProviderDefaultThinkingPolicyContext) {
  switch (params.provider.trim().toLowerCase()) {
    case "openai":
      return resolveUnifiedOpenAIThinkingProfile(
        params.modelId,
        params.agentRuntime,
        params.compat,
      );
    default:
      return null;
  }
}
