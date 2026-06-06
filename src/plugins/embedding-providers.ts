/** Registry for plugin-contributed embedding providers. */
import type {
  EmbeddingProviderAdapter,
  RegisteredEmbeddingProvider,
} from "./embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderRuntime,
  RegisteredEmbeddingProvider,
} from "./embedding-provider-types.js";

const EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.embeddingProviders");
const CORE_EMBEDDING_PROVIDERS: RegisteredEmbeddingProvider[] = [
  {
    adapter: openAICompatibleEmbeddingProviderAdapter,
    ownerPluginId: "core",
  },
];

function getEmbeddingProviders(): Map<string, RegisteredEmbeddingProvider> {
  // The registry is global so tests and lazy-loaded plugin modules share one provider table.
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[EMBEDDING_PROVIDERS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, RegisteredEmbeddingProvider>;
  }
  const created = new Map<string, RegisteredEmbeddingProvider>();
  globalStore[EMBEDDING_PROVIDERS_KEY] = created;
  return created;
}

function getCoreEmbeddingProvider(id: string): RegisteredEmbeddingProvider | undefined {
  return CORE_EMBEDDING_PROVIDERS.find((entry) => entry.adapter.id === id);
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
    getEmbeddingProviders().delete(adapter.id);
    return;
  }

  getEmbeddingProviders().set(adapter.id, {
    adapter,
    ownerPluginId: options?.ownerPluginId,
  });
}

/** Looks up the registered embedding provider entry, including owner metadata. */
export function getRegisteredEmbeddingProvider(
  id: string,
): RegisteredEmbeddingProvider | undefined {
  return getCoreEmbeddingProvider(id) ?? getEmbeddingProviders().get(id);
}

/** Returns only the embedding provider adapter for callers that do not need ownership metadata. */
export function getEmbeddingProvider(id: string): EmbeddingProviderAdapter | undefined {
  return getRegisteredEmbeddingProvider(id)?.adapter;
}

/** Lists registered embedding providers with core defaults merged first. */
export function listRegisteredEmbeddingProviders(): RegisteredEmbeddingProvider[] {
  const merged = new Map<string, RegisteredEmbeddingProvider>(
    CORE_EMBEDDING_PROVIDERS.map((entry) => [entry.adapter.id, entry]),
  );
  for (const entry of getEmbeddingProviders().values()) {
    if (!merged.has(entry.adapter.id)) {
      merged.set(entry.adapter.id, entry);
    }
  }
  return Array.from(merged.values());
}

/** Lists embedding provider adapters without registration metadata. */
export function listEmbeddingProviders(): EmbeddingProviderAdapter[] {
  return listRegisteredEmbeddingProviders().map((entry) => entry.adapter);
}

/** Replaces non-core embedding providers with adapter-only test/runtime state. */
export function restoreEmbeddingProviders(adapters: EmbeddingProviderAdapter[]): void {
  getEmbeddingProviders().clear();
  for (const adapter of adapters) {
    registerEmbeddingProvider(adapter);
  }
}

/** Replaces non-core embedding providers while preserving registration metadata. */
export function restoreRegisteredEmbeddingProviders(entries: RegisteredEmbeddingProvider[]): void {
  getEmbeddingProviders().clear();
  for (const entry of entries) {
    registerEmbeddingProvider(entry.adapter, {
      ownerPluginId: entry.ownerPluginId,
    });
  }
}

/** Clears non-core embedding providers from the process registry. */
export function clearEmbeddingProviders(): void {
  getEmbeddingProviders().clear();
}

export const resetEmbeddingProviders = clearEmbeddingProviders;
