/**
 * Provider-policy API for Anthropic and Claude CLI. Core calls this lightweight
 * path for config defaults and thinking profiles.
 */
import {
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { CLAUDE_CLI_OFF_THINKING_PROFILE } from "./cli-shared.js";
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
export function resolveThinkingProfile(params: {
  provider: string;
  modelId: string;
  params?: Record<string, unknown>;
}) {
  const contractModelId = resolveClaudeModelIdentity({
    id: params.modelId,
    params: params.params,
  });
  switch (params.provider.trim().toLowerCase()) {
    case "anthropic":
      return resolveClaudeThinkingProfile(contractModelId, undefined, {
        includeNativeMax: true,
      });
    case "claude-cli":
      if (resolveClaudeMythos5ModelIdentity({ id: contractModelId })) {
        return CLAUDE_CLI_OFF_THINKING_PROFILE;
      }
      // Claude Code exposes Fable's native effort ladder. Keep subscription-
      // backed and API-backed Fable routes on one model contract.
      return resolveClaudeThinkingProfile(contractModelId, undefined, {
        includeNativeMax: true,
      });
    default:
      return null;
  }
}
