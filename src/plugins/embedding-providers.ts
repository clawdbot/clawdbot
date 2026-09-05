import { CORE_EMBEDDING_PROVIDERS, getCoreEmbeddingProvider } from "./core-embedding-providers.js";
/** Registry for plugin-contributed embedding providers. */
import type {
  EmbeddingProviderAdapter,
  RegisteredEmbeddingProvider,
} from "./embedding-provider-types.js";
import { wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
import {
  assertDirectPluginRegistrationReplacement,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
  RegisteredEmbeddingProvider,
} from "./embedding-provider-types.js";

function getEmbeddingProviders(): RegisteredEmbeddingProvider[] {
  return requireActivePluginRegistry().embeddingProviders.map((entry) => ({
    adapter: entry.provider,
    ownerPluginId: entry.pluginId || undefined,
  }));
}

/** Registers an embedding provider adapter for plugin and built-in memory callers. */
export function registerEmbeddingProvider(
  adapter: EmbeddingProviderAdapter,
  options?: { ownerPluginId?: string },
): void {
  const coreEntry = getCoreEmbeddingProvider(adapter.id);
  if (coreEntry) {
    if (adapter !== coreEntry.adapter) {
      throw new Error(`embedding provider already registered: ${adapter.id} (owner: core)`);
    }
    const registry = requireActivePluginRegistry();
    registry.embeddingProviders = registry.embeddingProviders.filter(
      (entry) => entry.provider.id !== adapter.id,
    );
    return;
  }

  const registry = requireActivePluginRegistry();
  const pluginId = resolveDirectPluginRegistrationOwner(options?.ownerPluginId) ?? "";
  const existingIndex = registry.embeddingProviders.findIndex(
    (entry) => entry.provider.id === adapter.id,
  );
  if (existingIndex !== -1) {
    assertDirectPluginRegistrationReplacement(
      registry.embeddingProviders[existingIndex]?.pluginId || undefined,
      `embedding provider ${adapter.id}`,
    );
  }
  const entry = { pluginId, provider: wrapCurrentPluginInstance(adapter), source: "runtime" };
  if (existingIndex === -1) {
    registry.embeddingProviders.push(entry);
  } else {
    registry.embeddingProviders.splice(existingIndex, 1, entry);
  }
}

/** Looks up the registered embedding provider entry, including owner metadata. */
export function getRegisteredEmbeddingProvider(
  id: string,
): RegisteredEmbeddingProvider | undefined {
  return (
    getCoreEmbeddingProvider(id) ?? getEmbeddingProviders().find((entry) => entry.adapter.id === id)
  );
}
/** Lists registered embedding providers with core defaults merged first. */
export function listRegisteredEmbeddingProviders(): RegisteredEmbeddingProvider[] {
  const merged = new Map<string, RegisteredEmbeddingProvider>(
    CORE_EMBEDDING_PROVIDERS.map((entry) => [entry.adapter.id, entry]),
  );
  for (const entry of getEmbeddingProviders()) {
    if (!merged.has(entry.adapter.id)) {
      merged.set(entry.adapter.id, entry);
    }
  }
  return Array.from(merged.values());
} /** Replaces non-core embedding providers while preserving registration metadata. */
export function restoreRegisteredEmbeddingProviders(entries: RegisteredEmbeddingProvider[]): void {
  clearEmbeddingProviders();
  for (const entry of entries) {
    registerEmbeddingProvider(entry.adapter, {
      ownerPluginId: entry.ownerPluginId,
    });
  }
}

/** Clears non-core embedding providers from the process registry. */
export function clearEmbeddingProviders(): void {
  requireActivePluginRegistry().embeddingProviders.length = 0;
}
