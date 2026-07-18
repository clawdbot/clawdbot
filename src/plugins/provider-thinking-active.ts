// Reads provider thinking policy from the active runtime registry only.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";

type ActiveThinkingProvider = {
  id: string;
  aliases?: string[];
  hookAliases?: string[];
  isBinaryThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  supportsXHighThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  resolveDefaultThinkingLevel?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null | undefined;
};

type ActiveThinkingRegistryState = {
  activeRegistry?: {
    providers?: Array<{
      provider: ActiveThinkingProvider;
    }>;
  } | null;
};

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
};

function matchesProviderId(provider: ActiveThinkingProvider, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function resolveActiveThinkingProvider(providerId: string): ActiveThinkingProvider | undefined {
  const state = (
    globalThis as typeof globalThis & {
      [PLUGIN_REGISTRY_STATE]?: ActiveThinkingRegistryState;
    }
  )[PLUGIN_REGISTRY_STATE];
  return state?.activeRegistry?.providers?.find((entry) =>
    matchesProviderId(entry.provider, providerId),
  )?.provider;
}

export function resolveActiveProviderBinaryThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.isBinaryThinking?.(params.context);
}

export function resolveActiveProviderXHighThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.supportsXHighThinking?.(params.context);
}

export function resolveActiveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(params.context);
}

export function resolveActiveProviderDefaultThinkingLevel(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveDefaultThinkingLevel?.(
    params.context,
  );
}
