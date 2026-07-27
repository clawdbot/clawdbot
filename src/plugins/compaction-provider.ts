/**
 * Compaction provider registry — process-global singleton.
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
type RegisteredCompactionProvider = {
  provider: CompactionProvider;
  ownerPluginId?: string;
};

// ---------------------------------------------------------------------------
// Registry (process-global singleton)
// ---------------------------------------------------------------------------

const COMPACTION_PROVIDER_REGISTRY_STATE = Symbol.for("openclaw.compactionProviderRegistryState");

type CompactionProviderRegistryState = {
  providers: Map<string, RegisteredCompactionProvider>;
};

// Keep compaction-provider registrations process-global so duplicated dist
// chunks still share one registry map at runtime.
function getCompactionProviderRegistryState(): CompactionProviderRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [COMPACTION_PROVIDER_REGISTRY_STATE]?: CompactionProviderRegistryState;
  };
  if (!globalState[COMPACTION_PROVIDER_REGISTRY_STATE]) {
    globalState[COMPACTION_PROVIDER_REGISTRY_STATE] = {
      providers: new Map<string, RegisteredCompactionProvider>(),
    };
  }
  return globalState[COMPACTION_PROVIDER_REGISTRY_STATE];
}

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
  getCompactionProviderRegistryState().providers.set(provider.id, {
    provider,
    ownerPluginId: options?.ownerPluginId,
  });
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Return the provider for the given id, or undefined. */
export function getCompactionProvider(id: string): CompactionProvider | undefined {
  return getCompactionProviderRegistryState().providers.get(id)?.provider;
}

/** Return the registered entry (provider + owner) for the given id. */
export function getRegisteredCompactionProvider(
  id: string,
): RegisteredCompactionProvider | undefined {
  return getCompactionProviderRegistryState().providers.get(id);
}

/** List all registered entries with owner metadata (for snapshot/restore). */
export function listRegisteredCompactionProviders(): RegisteredCompactionProvider[] {
  return Array.from(getCompactionProviderRegistryState().providers.values());
}

// ---------------------------------------------------------------------------
// Lifecycle (clear / restore) — mirrors memory-embedding-providers.ts
// ---------------------------------------------------------------------------

/** Clear all compaction providers. Used by clearPluginLoaderCache() and reload. */
export function clearCompactionProviders(): void {
  getCompactionProviderRegistryState().providers.clear();
}

/** Restore from a snapshot, replacing all current entries. */
export function restoreRegisteredCompactionProviders(
  entries: RegisteredCompactionProvider[],
): void {
  const map = getCompactionProviderRegistryState().providers;
  map.clear();
  for (const entry of entries) {
    map.set(entry.provider.id, entry);
  }
}
