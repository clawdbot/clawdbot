import {
  assertDirectPluginRegistrationReplacement,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";

/**
 * Compaction provider facade over the active plugin registry.
 *
 * Plugins implement the CompactionProvider interface and register via
 * `registerCompactionProvider()`. The compaction safeguard checks this
 * registry before falling back to the built-in `summarizeInStages()`.
 */

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A pluggable compaction provider that can replace the built-in
 * summarizeInStages pipeline.
 */
type CompactionProviderSummarizationInstructions = {
  identifierPolicy?: "strict" | "off" | "custom";
  identifierInstructions?: string;
};

export interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    compressionRatio?: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionProviderSummarizationInstructions;
    /** Summary from a prior compaction round, if re-compacting. */
    previousSummary?: string;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Registered entry (mirrors RegisteredMemoryEmbeddingProvider pattern)
// ---------------------------------------------------------------------------

/** A compaction provider with its owning plugin id for lifecycle tracking. */
export type RegisteredCompactionProvider = {
  provider: CompactionProvider;
  ownerPluginId?: string;
};

// ---------------------------------------------------------------------------
// Registry (process-global singleton)
// ---------------------------------------------------------------------------

const getProviders = () => requireActivePluginRegistry().compactionProviders;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a compaction provider implementation.
 * Pass `ownerPluginId` so the loader can snapshot/restore correctly.
 */
export function registerCompactionProvider(
  provider: CompactionProvider,
  options?: { ownerPluginId?: string },
): void {
  const providers = getProviders();
  const ownerPluginId = resolveDirectPluginRegistrationOwner(options?.ownerPluginId);
  const entry = {
    provider,
    ownerPluginId,
  };
  const index = providers.findIndex((registered) => registered.provider.id === provider.id);
  if (index !== -1) {
    assertDirectPluginRegistrationReplacement(
      providers[index]?.ownerPluginId,
      `compaction provider ${provider.id}`,
    );
  }
  index === -1 ? providers.push(entry) : providers.splice(index, 1, entry);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Return the provider for the given id, or undefined. */
export function getCompactionProvider(id: string): CompactionProvider | undefined {
  return getProviders().find((entry) => entry.provider.id === id)?.provider;
}

/** Return the registered entry (provider + owner) for the given id. */
export function getRegisteredCompactionProvider(
  id: string,
): RegisteredCompactionProvider | undefined {
  return getProviders().find((entry) => entry.provider.id === id);
}

/** List all registered entries with owner metadata (for snapshot/restore). */
export function listRegisteredCompactionProviders(): RegisteredCompactionProvider[] {
  return [...getProviders()];
}

// ---------------------------------------------------------------------------
// Lifecycle (clear / restore) — mirrors memory-embedding-providers.ts
// ---------------------------------------------------------------------------

/** Clear all compaction providers. Used by clearPluginLoaderCache() and reload. */
export function clearCompactionProviders(): void {
  getProviders().length = 0;
}

/** Restore from a snapshot, replacing all current entries. */
export function restoreRegisteredCompactionProviders(
  entries: RegisteredCompactionProvider[],
): void {
  getProviders().splice(0, getProviders().length, ...entries);
}
