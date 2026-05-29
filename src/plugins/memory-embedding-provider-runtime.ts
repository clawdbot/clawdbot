import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getRuntimeEmbeddingProviderAdapter,
  listRuntimeEmbeddingProviderAdapters,
  readConfiguredProviderApiId,
  resolveRuntimeEmbeddingProviderLookupIds,
} from "./embedding-provider-runtime-shared.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";

export { listRegisteredMemoryEmbeddingProviders };

export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  return listRuntimeEmbeddingProviderAdapters({
    key: "memoryEmbeddingProviders",
    cfg,
    registered: listRegisteredMemoryEmbeddingProviderAdapters(),
  });
}

function resolveConfiguredMemoryEmbeddingProviderId(
  providerId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  return readConfiguredProviderApiId({ providerId, cfg });
}

function resolveMemoryEmbeddingProviderLookupIds(id: string, cfg?: OpenClawConfig): string[] {
  return resolveRuntimeEmbeddingProviderLookupIds({
    id,
    cfg,
    resolveConfiguredProviderId: resolveConfiguredMemoryEmbeddingProviderId,
  });
}

export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  return getRuntimeEmbeddingProviderAdapter({
    key: "memoryEmbeddingProviders",
    cfg,
    lookupIds: resolveMemoryEmbeddingProviderLookupIds(id, cfg),
    getRegisteredProvider: getRegisteredMemoryEmbeddingProvider,
  });
}
