import type {
  MemoryEmbeddingProviderAdapter,
  RegisteredMemoryEmbeddingProvider,
} from "./registry-contribution-types.js";
import {
  assertDirectPluginRegistrationReplacement,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";

export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCallOptions,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderIndexIdentity,
  MemoryEmbeddingProviderRuntime,
  RegisteredMemoryEmbeddingProvider,
} from "./registry-contribution-types.js";

function getMemoryEmbeddingProviders(): RegisteredMemoryEmbeddingProvider[] {
  return requireActivePluginRegistry().memoryEmbeddingProviders.map((entry) => ({
    adapter: entry.provider,
    ownerPluginId: entry.pluginId || undefined,
  }));
}

export function registerMemoryEmbeddingProvider(
  adapter: MemoryEmbeddingProviderAdapter,
  options?: { ownerPluginId?: string },
): void {
  const registry = requireActivePluginRegistry();
  const pluginId = resolveDirectPluginRegistrationOwner(options?.ownerPluginId) ?? "";
  const entry = {
    pluginId,
    provider: adapter,
    source: "runtime",
  };
  const index = registry.memoryEmbeddingProviders.findIndex(
    (registration) => registration.provider.id === adapter.id,
  );
  if (index !== -1) {
    assertDirectPluginRegistrationReplacement(
      registry.memoryEmbeddingProviders[index]?.pluginId || undefined,
      `memory embedding provider ${adapter.id}`,
    );
  }
  if (index === -1) {
    registry.memoryEmbeddingProviders.push(entry);
  } else {
    registry.memoryEmbeddingProviders.splice(index, 1, entry);
  }
}

export function getRegisteredMemoryEmbeddingProvider(
  id: string,
): RegisteredMemoryEmbeddingProvider | undefined {
  return getMemoryEmbeddingProviders().find((entry) => entry.adapter.id === id);
}

export function listRegisteredMemoryEmbeddingProviders(): RegisteredMemoryEmbeddingProvider[] {
  return getMemoryEmbeddingProviders();
}

export function restoreRegisteredMemoryEmbeddingProviders(
  entries: RegisteredMemoryEmbeddingProvider[],
): void {
  clearMemoryEmbeddingProviders();
  for (const entry of entries) {
    registerMemoryEmbeddingProvider(entry.adapter, {
      ownerPluginId: entry.ownerPluginId,
    });
  }
}

export function clearMemoryEmbeddingProviders(): void {
  requireActivePluginRegistry().memoryEmbeddingProviders.length = 0;
}
