// Reads provider thinking policy from the active runtime registry only.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";

type ActiveThinkingProvider = {
  id: string;
  aliases?: string[];
  hookAliases?: string[];
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
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

export function resolveActiveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(params.context);
}
