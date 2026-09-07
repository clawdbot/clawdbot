import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  acquireEmbeddingProvider,
  getEmbeddingProviderCore,
  listEmbeddingProvidersCore,
  listRegisteredEmbeddingProviderAdapters,
} from "./embedding-provider-runtime.js";
import { listRegisteredEmbeddingProviders } from "./embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";

/** Lists registered memory embedding provider adapters without registry metadata. */
export function listRegisteredMemoryEmbeddingProviderAdaptersCore(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredEmbeddingProviderAdapters();
}

/** Copies diagnostic values without borrowing executable adapters or their native resources. */
export function listRegisteredMemoryEmbeddingProviderIds(): string[] {
  return listRegisteredEmbeddingProviders().map((entry) => entry.adapter.id);
}

/** Lists memory embedding providers from runtime config and registered adapters. */
export function listMemoryEmbeddingProvidersCore(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  return listEmbeddingProvidersCore(cfg);
}

/** Resolves one memory embedding provider by id, alias, or configured API owner. */
export function getMemoryEmbeddingProviderCore(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  return getEmbeddingProviderCore(id, cfg);
}

/** Preserves memory's extended adapter create-options contract on explicit acquisitions. */
export const acquireMemoryEmbeddingProvider: (
  ...args: Parameters<typeof getMemoryEmbeddingProviderCore>
) => Omit<ReturnType<typeof acquireEmbeddingProvider>, "provider"> & {
  provider: MemoryEmbeddingProviderAdapter | undefined;
} = acquireEmbeddingProvider;
