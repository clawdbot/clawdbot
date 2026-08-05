// Reads only already-loaded provider hooks through process-global registry slots.
// Keep this leaf free of gateway and plugin barrels so agent error paths stay acyclic.
import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";
import type {
  ProviderFailoverErrorContext,
  ProviderFailoverHook,
} from "./provider-failover.types.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";
import { PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY } from "./runtime/gateway-request-scope-key.js";

type ProviderRegistryView = {
  providers: Array<{ provider: ProviderFailoverHook }>;
};

type GatewayRequestScopeStorage = {
  getStore: () => { pluginRegistry?: ProviderRegistryView } | undefined;
};

type LoadedProviderPlugins = {
  matched: boolean;
  plugins: ProviderFailoverHook[];
};

function readGlobalSlot(key: symbol): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[key];
}

function resolveLoadedProviderPlugins(provider: string): LoadedProviderPlugins {
  const requestRegistry = (
    readGlobalSlot(PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY) as
      | GatewayRequestScopeStorage
      | undefined
  )?.getStore()?.pluginRegistry;
  const activeRegistry = (
    readGlobalSlot(PLUGIN_REGISTRY_STATE) as
      | { activeRegistry?: ProviderRegistryView | null }
      | undefined
  )?.activeRegistry;
  const providers = (requestRegistry ?? activeRegistry)?.providers.map((entry) => entry.provider);
  if (!providers) {
    return { matched: false, plugins: [] };
  }
  const matched = providers.find((candidate) => matchesProviderPluginRef(candidate, provider));
  return matched ? { matched: true, plugins: [matched] } : { matched: false, plugins: [] };
}

/** Classifies through an explicitly matched provider hook already owned by this runtime. */
export function classifyLoadedProviderFailoverReason(params: {
  provider: string;
  context: ProviderFailoverErrorContext;
}): { matched: boolean; reason: FailoverReason | null } {
  const loaded = resolveLoadedProviderPlugins(params.provider);
  for (const plugin of loaded.plugins) {
    const reason = plugin.classifyFailoverReason?.(params.context);
    if (reason) {
      return { matched: true, reason };
    }
  }
  return { matched: loaded.matched, reason: null };
}
