/** Shared runtime helpers for embedding provider lookup across core and plugin capabilities. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
  type CapabilityProviderFor,
} from "./capability-provider-runtime.js";

type EmbeddingProviderCapabilityKey = "embeddingProviders";
type RegisteredAdapterEntry<TAdapter> = {
  adapter: TAdapter;
};

/** Builds lookup ids for embedding providers, including configured API aliases. */
export function resolveRuntimeEmbeddingProviderLookupIds(params: {
  id: string;
  cfg?: OpenClawConfig;
  resolveConfiguredProviderId: (id: string, cfg?: OpenClawConfig) => string | undefined;
}): string[] {
  const ids = [params.id];
  const configuredProviderId = params.resolveConfiguredProviderId(params.id, params.cfg);
  if (
    configuredProviderId &&
    !ids.some((candidate) => normalizeProviderId(candidate) === configuredProviderId)
  ) {
    ids.push(configuredProviderId);
  }
  return ids;
}

/** Lists registered and plugin-contributed embedding provider adapters for a capability key. */
export function listRuntimeEmbeddingProviderAdapters<
  K extends EmbeddingProviderCapabilityKey,
>(params: {
  key: K;
  cfg?: OpenClawConfig;
  registered: CapabilityProviderFor<K>[];
}): CapabilityProviderFor<K>[] {
  const merged = new Map(params.registered.map((adapter) => [adapter.id, adapter]));
  const capabilityAdapters = resolvePluginCapabilityProviders({
    key: params.key,
    cfg: params.cfg,
  });
  for (const adapter of capabilityAdapters) {
    if (!merged.has(adapter.id)) {
      merged.set(adapter.id, adapter);
    }
  }
  return [...merged.values()];
}

/** Resolves one embedding provider adapter from registered providers before plugin capabilities. */
export function getRuntimeEmbeddingProviderAdapter<
  K extends EmbeddingProviderCapabilityKey,
>(params: {
  key: K;
  cfg?: OpenClawConfig;
  lookupIds: string[];
  getRegisteredProvider: (
    id: string,
  ) => RegisteredAdapterEntry<CapabilityProviderFor<K>> | undefined;
}): CapabilityProviderFor<K> | undefined {
  // Resolve each exact id before trying the next configured alias. Otherwise a
  // registered alias can shadow a plugin-owned adapter for the requested id.
  for (const candidateId of params.lookupIds) {
    const registered = params.getRegisteredProvider(candidateId);
    if (registered) {
      return registered.adapter;
    }
    const provider = resolvePluginCapabilityProvider({
      key: params.key,
      providerId: candidateId,
      cfg: params.cfg,
    });
    if (provider) {
      return provider;
    }
  }
  return undefined;
}
