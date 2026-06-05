/**
 * Provider-policy API for Anthropic and Claude CLI. Core calls this lightweight
 * path for config defaults and thinking profiles.
 */
import { resolveClaudeThinkingProfile } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";

/** Normalize Anthropic provider config without importing runtime registration. */
export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return normalizeAnthropicProviderConfigForProvider(params);
}

/** Apply Anthropic config defaults through the provider-policy seam. */
export function applyConfigDefaults(params: Parameters<typeof applyAnthropicConfigDefaults>[0]) {
  return applyAnthropicConfigDefaults(params);
}

/** Resolve Claude thinking profile for Anthropic or Claude CLI providers. */
export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  switch (params.provider.trim().toLowerCase()) {
    case "anthropic":
    case "claude-cli":
      return resolveClaudeThinkingProfile(params.modelId);
    default:
      return null;
  }
}
