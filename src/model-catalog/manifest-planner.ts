import { normalizeModelCatalogProviderRows } from "./normalize.js";
import { normalizeModelCatalogProviderId } from "./refs.js";
import type { ModelCatalog, NormalizedModelCatalogRow } from "./types.js";

export type ManifestModelCatalogPlugin = {
  id: string;
  modelCatalog?: Pick<ModelCatalog, "providers">;
};

export type ManifestModelCatalogRegistry = {
  plugins: readonly ManifestModelCatalogPlugin[];
};

export type ManifestModelCatalogPlanEntry = {
  pluginId: string;
  provider: string;
  rows: readonly NormalizedModelCatalogRow[];
};

export type ManifestModelCatalogConflict = {
  mergeKey: string;
  ref: string;
  provider: string;
  modelId: string;
  firstPluginId: string;
  secondPluginId: string;
};

export type ManifestModelCatalogPlan = {
  rows: readonly NormalizedModelCatalogRow[];
  entries: readonly ManifestModelCatalogPlanEntry[];
  conflicts: readonly ManifestModelCatalogConflict[];
};

export function planManifestModelCatalogRows(params: {
  registry: ManifestModelCatalogRegistry;
  providerFilter?: string;
}): ManifestModelCatalogPlan {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  const entries: ManifestModelCatalogPlanEntry[] = [];

  for (const plugin of params.registry.plugins) {
    for (const entry of planManifestModelCatalogPluginEntries({ plugin, providerFilter })) {
      entries.push(entry);
    }
  }

  const rowCandidates: NormalizedModelCatalogRow[] = [];
  const seenRows = new Map<string, { pluginId: string; row: NormalizedModelCatalogRow }>();
  const conflicts = new Map<string, ManifestModelCatalogConflict>();
  for (const entry of entries) {
    for (const row of entry.rows) {
      const seen = seenRows.get(row.mergeKey);
      if (seen) {
        if (!conflicts.has(row.mergeKey)) {
          conflicts.set(row.mergeKey, {
            mergeKey: row.mergeKey,
            ref: seen.row.ref,
            provider: seen.row.provider,
            modelId: seen.row.id,
            firstPluginId: seen.pluginId,
            secondPluginId: entry.pluginId,
          });
        }
        continue;
      }
      seenRows.set(row.mergeKey, { pluginId: entry.pluginId, row });
      rowCandidates.push(row);
    }
  }

  const conflictedMergeKeys = new Set(conflicts.keys());
  const rows = rowCandidates.filter((row) => !conflictedMergeKeys.has(row.mergeKey));

  return {
    entries,
    conflicts: [...conflicts.values()],
    rows: rows.toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
    ),
  };
}

function planManifestModelCatalogPluginEntries(params: {
  plugin: ManifestModelCatalogPlugin;
  providerFilter: string | undefined;
}): ManifestModelCatalogPlanEntry[] {
  const providers = params.plugin.modelCatalog?.providers;
  if (!providers) {
    return [];
  }

  return Object.entries(providers).flatMap(([provider, providerCatalog]) => {
    const normalizedProvider = normalizeModelCatalogProviderId(provider);
    if (
      !normalizedProvider ||
      (params.providerFilter && normalizedProvider !== params.providerFilter)
    ) {
      return [];
    }
    const rows = normalizeModelCatalogProviderRows({
      provider: normalizedProvider,
      providerCatalog,
      source: "manifest",
    });
    if (rows.length === 0) {
      return [];
    }
    return [
      {
        pluginId: params.plugin.id,
        provider: normalizedProvider,
        rows,
      },
    ];
  });
}
