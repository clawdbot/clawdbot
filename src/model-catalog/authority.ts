// Model-catalog authority merging chooses the strongest source for duplicate provider/model rows.
import type {
  ModelCatalogSource,
  NormalizedModelCatalogRow,
} from "@openclaw/model-catalog-core/model-catalog-types";

// Source authority decides which duplicate catalog row survives when providers,
// manifests, config, and cache all describe the same provider/model merge key.
const MODEL_CATALOG_SOURCE_AUTHORITY: Readonly<Record<ModelCatalogSource, number>> = {
  config: 0,
  manifest: 1,
  cache: 2,
  "runtime-refresh": 2,
  "provider-index": 3,
};

function compareModelCatalogSourceAuthority(
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
    // Lower numeric authority wins: explicit config beats manifest/runtime
    // discovery, while provider-index preview data is the weakest source.
    if (!existing || compareModelCatalogSourceAuthority(row.source, existing.source) < 0) {
      byMergeKey.set(row.mergeKey, row);
    }
  }
  return [...byMergeKey.values()].toSorted(
    (left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
}
