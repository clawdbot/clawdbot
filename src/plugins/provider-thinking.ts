import { normalizeProviderId } from "../agents/provider-id.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";
import { getActivePluginRegistry } from "./runtime.js";

type ThinkingProviderPlugin = {
  id: string;
  aliases?: string[];
  isBinaryThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  supportsXHighThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  resolveDefaultThinkingLevel?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null | undefined;
};

function matchesProviderId(provider: ThinkingProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === normalized);
}

function resolveActiveThinkingProvider(providerId: string): ThinkingProviderPlugin | undefined {
  return getActivePluginRegistry()?.providers.find((entry) => {
    return matchesProviderId(entry.provider, providerId);
  })?.provider;
}

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
};

export function resolveProviderBinaryThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.isBinaryThinking?.(params.context);
}

export function resolveProviderXHighThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.supportsXHighThinking?.(params.context);
}

export function resolveProviderDefaultThinkingLevel(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveDefaultThinkingLevel?.(
    params.context,
  );
}
