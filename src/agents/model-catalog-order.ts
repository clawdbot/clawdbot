import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

/**
 * Provider catalogs declare models strongest-first. Preserve that owner order
 * after registry/config merges instead of falling back to alphabetical names.
 */
export function assignProviderModelOrder(
  entries: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const nextOrderByProvider = new Map<string, number>();
  return entries.map((entry) => {
    const provider = normalizeProviderId(entry.provider);
    const providerOrder = nextOrderByProvider.get(provider) ?? 0;
    nextOrderByProvider.set(provider, providerOrder + 1);
    return { ...entry, providerOrder };
  });
}

export function compareModelCatalogEntries(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  const providerComparison = normalizeProviderId(a.provider).localeCompare(
    normalizeProviderId(b.provider),
  );
  if (providerComparison !== 0) {
    return providerComparison;
  }
  const orderComparison =
    (a.providerOrder ?? Number.MAX_SAFE_INTEGER) - (b.providerOrder ?? Number.MAX_SAFE_INTEGER);
  return orderComparison || a.id.localeCompare(b.id) || a.name.localeCompare(b.name);
}
