import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { normalizeGoogleProviderConfig, resolveGoogleThinkingProfile } from "./provider-policy.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return normalizeGoogleProviderConfig(params.provider, params.providerConfig);
}

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  return resolveGoogleThinkingProfile(context);
}
