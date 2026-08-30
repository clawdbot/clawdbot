// Reads provider thinking policy from a prepared, scoped, or active runtime registry.
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingRegistry,
} from "./provider-thinking.types.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

type ActiveThinkingRegistryState = {
  activeRegistry?: ProviderThinkingRegistry | null;
};

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
};

function resolveActiveThinkingProvider(providerId: string, registry?: ProviderThinkingRegistry) {
  const state = (
    globalThis as typeof globalThis & {
      [PLUGIN_REGISTRY_STATE]?: ActiveThinkingRegistryState;
    }
  )[PLUGIN_REGISTRY_STATE];
  const owner =
    registry ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? state?.activeRegistry;
  return owner?.providers?.find((entry) => matchesProviderPluginRef(entry.provider, providerId))
    ?.provider;
}

export function resolveActiveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
  registry?: ProviderThinkingRegistry,
) {
  return resolveActiveThinkingProvider(params.provider, registry)?.resolveThinkingProfile?.(
    params.context,
  );
}
