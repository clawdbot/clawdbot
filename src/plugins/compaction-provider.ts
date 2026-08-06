import type {
  CompactionProvider,
  RegisteredCompactionProvider,
} from "./registry-contribution-types.js";
import {
  assertDirectPluginRegistrationReplacement,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";

export type { CompactionProvider } from "./registry-contribution-types.js";

const getProviders = () => requireActivePluginRegistry().compactionProviders;

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
  if (index === -1) {
    providers.push(entry);
  } else {
    providers.splice(index, 1, entry);
  }
}

export function getCompactionProvider(id: string): CompactionProvider | undefined {
  return getProviders().find((entry) => entry.provider.id === id)?.provider;
}

export function getRegisteredCompactionProvider(
  id: string,
): RegisteredCompactionProvider | undefined {
  return getProviders().find((entry) => entry.provider.id === id);
}

export function listRegisteredCompactionProviders(): RegisteredCompactionProvider[] {
  return [...getProviders()];
}

export function clearCompactionProviders(): void {
  getProviders().length = 0;
}
