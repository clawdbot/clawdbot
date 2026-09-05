import type { CompactionProvider } from "./registry-contribution-types.js";
import { requireActivePluginRegistry } from "./runtime.js";

export type { CompactionProvider } from "./registry-contribution-types.js";

export function getCompactionProvider(id: string): CompactionProvider | undefined {
  return requireActivePluginRegistry().compactionProviders.find((entry) => entry.provider.id === id)
    ?.provider;
}
