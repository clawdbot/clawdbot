import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/core";
import {
  matchesExactOrPrefix,
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const UPSTREAM_OPENAI_PREFIX = "openai/";
const UPSTREAM_ANTHROPIC_PREFIX = "anthropic/";

const BASE_OPENAI_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

const VERCEL_OPENAI_XHIGH_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const;

function stripTrustedUpstreamPrefix(modelId: string, prefix: string): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized.startsWith(prefix)) {
    return null;
  }
  const upstreamModelId = normalized.slice(prefix.length).trim();
  return upstreamModelId || null;
}

function resolveOpenAiThinkingProfile(modelId: string): ProviderThinkingProfile | undefined {
  if (!matchesExactOrPrefix(modelId, VERCEL_OPENAI_XHIGH_MODEL_IDS)) {
    return undefined;
  }
  return {
    levels: [...BASE_OPENAI_THINKING_LEVELS, { id: "xhigh" }],
  };
}

function hasVercelSpecificClaudeProfile(profile: ProviderThinkingProfile): boolean {
  return Boolean(
    profile.defaultLevel ||
    profile.levels.some(
      (level) => level.id === "adaptive" || level.id === "xhigh" || level.id === "max",
    ),
  );
}

export function resolveVercelAiGatewayThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  const openAiModelId = stripTrustedUpstreamPrefix(modelId, UPSTREAM_OPENAI_PREFIX);
  if (openAiModelId) {
    return resolveOpenAiThinkingProfile(openAiModelId);
  }

  const anthropicModelId = stripTrustedUpstreamPrefix(modelId, UPSTREAM_ANTHROPIC_PREFIX);
  if (anthropicModelId) {
    const profile = resolveClaudeThinkingProfile(anthropicModelId);
    // Returning a base-only provider profile would hide catalog compat metadata
    // from generic thinking resolution. Only take over when Claude has an
    // upstream-specific default or elevated level set.
    return hasVercelSpecificClaudeProfile(profile) ? profile : undefined;
  }

  return undefined;
}
