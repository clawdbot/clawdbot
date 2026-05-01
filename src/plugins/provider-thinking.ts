import { normalizeProviderId } from "../agents/provider-id.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";

type ThinkingProviderPlugin = {
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

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type ThinkingRegistryState = {
  activeRegistry?: {
    providers?: Array<{
      provider: ThinkingProviderPlugin;
    }>;
  } | null;
};

function matchesProviderId(provider: ThinkingProviderPlugin, providerId: string): boolean {
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

function resolveActiveThinkingProvider(providerId: string): ThinkingProviderPlugin | undefined {
  const state = (
    globalThis as typeof globalThis & { [PLUGIN_REGISTRY_STATE]?: ThinkingRegistryState }
  )[PLUGIN_REGISTRY_STATE];
  const activeProvider = state?.activeRegistry?.providers?.find((entry) => {
    return matchesProviderId(entry.provider, providerId);
  })?.provider;
  if (activeProvider) {
    return activeProvider;
  }
  return undefined;
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

export function resolveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  const activeProfile = resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(
    params.context,
  );
  if (activeProfile) {
    return activeProfile;
  }
  return resolveBundledProviderPolicySurface(params.provider)?.resolveThinkingProfile?.(
    params.context,
  );
}

export function resolveProviderDefaultThinkingLevel(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveDefaultThinkingLevel?.(
    params.context,
  );
}
