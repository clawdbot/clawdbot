import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";

/**
 * Provider catalogs declare models strongest-first. Preserve that owner order
 * after registry/config merges instead of falling back to alphabetical names.
 */
export function assignProviderModelOrder(
  entries: readonly ModelCatalogEntry[],
  existingEntries: readonly ModelCatalogEntry[] = [],
  options: { appendUnknown?: boolean } = {},
): ModelCatalogEntry[] {
  const orderByModel = new Map<string, number>();
  const nextOrderByProvider = new Map<string, number>();
  for (const entry of existingEntries) {
    if (entry.providerOrder === undefined) {
      continue;
    }
    const provider = normalizeProviderId(entry.provider);
    const key = resolveModelCatalogIdentityKey(entry);
    orderByModel.set(key, entry.providerOrder);
    nextOrderByProvider.set(
      provider,
      Math.max(nextOrderByProvider.get(provider) ?? 0, entry.providerOrder + 1),
    );
  }
  return entries.map((entry) => {
    const provider = normalizeProviderId(entry.provider);
    const key = resolveModelCatalogIdentityKey(entry);
    const existingOrder = orderByModel.get(key);
    if (existingOrder !== undefined) {
      return { ...entry, providerOrder: existingOrder };
    }
    if (options.appendUnknown === false) {
      return entry;
    }
    const providerOrder = nextOrderByProvider.get(provider) ?? 0;
    nextOrderByProvider.set(provider, providerOrder + 1);
    orderByModel.set(key, providerOrder);
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
