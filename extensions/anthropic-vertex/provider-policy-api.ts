/**
 * Provider-policy API for Anthropic Vertex. Core asks for thinking profiles
 * without importing the provider entry or stream runtime.
 */
import { resolveClaudeThinkingProfile } from "openclaw/plugin-sdk/provider-model-shared";

/** Resolve Anthropic Vertex thinking profile for a provider/model pair. */
export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  if (params.provider.trim().toLowerCase() !== "anthropic-vertex") {
    return null;
  }
  return resolveClaudeThinkingProfile(params.modelId);
}
