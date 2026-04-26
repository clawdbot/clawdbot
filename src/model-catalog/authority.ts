import type { ModelCatalogSource, NormalizedModelCatalogRow } from "./types.js";

const MODEL_CATALOG_SOURCE_AUTHORITY: Readonly<Record<ModelCatalogSource, number>> = {
  config: 0,
  manifest: 1,
  cache: 2,
  "runtime-refresh": 2,
  "provider-index": 3,
};

export function compareModelCatalogSourceAuthority(
  left: ModelCatalogSource,
  right: ModelCatalogSource,
): number {
  return MODEL_CATALOG_SOURCE_AUTHORITY[left] - MODEL_CATALOG_SOURCE_AUTHORITY[right];
}

export function mergeModelCatalogRowsByAuthority(
  rows: Iterable<NormalizedModelCatalogRow>,
): NormalizedModelCatalogRow[] {
  const byMergeKey = new Map<string, NormalizedModelCatalogRow>();
  for (const row of rows) {
    const existing = byMergeKey.get(row.mergeKey);
    if (!existing || compareModelCatalogSourceAuthority(row.source, existing.source) < 0) {
      byMergeKey.set(row.mergeKey, row);
    }
  }
  return [...byMergeKey.values()].toSorted(
    (left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
}
