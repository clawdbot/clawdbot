import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeModelCatalogProviderRows } from "./normalize.js";
import { buildModelCatalogMergeKey, normalizeModelCatalogProviderId } from "./refs.js";
import type {
  ModelCatalog,
  ModelCatalogAlias,
  ModelCatalogDiscovery,
  NormalizedModelCatalogRow,
} from "./types.js";

type ManifestModelCatalogPlugin = {
  id: string;
  providers?: readonly string[];
  modelCatalog?: Pick<ModelCatalog, "providers" | "aliases" | "suppressions" | "discovery">;
};

type ManifestModelCatalogRegistry = {
  plugins: readonly ManifestModelCatalogPlugin[];
};

type ManifestModelCatalogPlanEntry = {
  pluginId: string;
  provider: string;
  discovery?: ModelCatalogDiscovery;
  rows: readonly NormalizedModelCatalogRow[];
};

type ManifestModelCatalogConflict = {
  mergeKey: string;
  ref: string;
  provider: string;
  modelId: string;
  firstPluginId: string;
  secondPluginId: string;
};

type ManifestModelCatalogPlan = {
  rows: readonly NormalizedModelCatalogRow[];
  entries: readonly ManifestModelCatalogPlanEntry[];
  conflicts: readonly ManifestModelCatalogConflict[];
};

export type ManifestModelCatalogSuppressionEntry = {
  pluginId: string;
  provider: string;
  model: string;
  mergeKey: string;
  reason?: string;
  when?: NonNullable<ModelCatalog["suppressions"]>[number]["when"];
};

type ManifestModelCatalogSuppressionPlan = {
  suppressions: readonly ManifestModelCatalogSuppressionEntry[];
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

  const aliasesByTargetProvider = buildModelCatalogProviderAliasTargets(params.plugin);

  return Object.entries(providers).flatMap(([provider, providerCatalog]) => {
    const normalizedProvider = normalizeModelCatalogProviderId(provider);
    if (!normalizedProvider) {
      return [];
    }
    const providerAliases = aliasesByTargetProvider.get(normalizedProvider) ?? [];
    const plannedProviders = params.providerFilter
      ? providerAliases.includes(params.providerFilter) ||
        normalizedProvider === params.providerFilter
        ? [params.providerFilter]
        : []
      : [normalizedProvider];
    if (plannedProviders.length === 0) {
      return [];
    }
    return plannedProviders.flatMap((plannedProvider) => {
      const rows = normalizeModelCatalogProviderRows({
        provider: plannedProvider,
        providerCatalog,
        source: "manifest",
      });
      if (rows.length === 0) {
        return [];
      }
      return [
        {
          pluginId: params.plugin.id,
          provider: plannedProvider,
          discovery: params.plugin.modelCatalog?.discovery?.[normalizedProvider],
          rows: applyModelCatalogAliasOverrides({
            rows,
            alias: params.plugin.modelCatalog?.aliases?.[plannedProvider],
          }),
        },
      ];
    });
  });
}

function buildOwnedProviderSet(plugin: ManifestModelCatalogPlugin): ReadonlySet<string> {
  return new Set((plugin.providers ?? []).map(normalizeModelCatalogProviderId).filter(Boolean));
}

function buildModelCatalogProviderAliasTargets(
  plugin: ManifestModelCatalogPlugin,
): ReadonlyMap<string, readonly string[]> {
  const ownedProviders = buildOwnedProviderSet(plugin);
  const aliasesByTargetProvider = new Map<string, string[]>();
  for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
    const aliasProvider = normalizeModelCatalogProviderId(rawAlias);
    const targetProvider = normalizeModelCatalogProviderId(alias.provider);
    if (!aliasProvider || !targetProvider || !ownedProviders.has(targetProvider)) {
      continue;
    }
    const aliases = aliasesByTargetProvider.get(targetProvider) ?? [];
    aliases.push(aliasProvider);
    aliasesByTargetProvider.set(targetProvider, aliases);
  }
  return aliasesByTargetProvider;
}

function buildModelCatalogProviderRefs(plugin: ManifestModelCatalogPlugin): ReadonlySet<string> {
  const ownedProviders = buildOwnedProviderSet(plugin);
  const refs = new Set(ownedProviders);
  for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
    const aliasProvider = normalizeModelCatalogProviderId(rawAlias);
    const targetProvider = normalizeModelCatalogProviderId(alias.provider);
    if (aliasProvider && targetProvider && ownedProviders.has(targetProvider)) {
      refs.add(aliasProvider);
    }
  }
  return refs;
}

function applyModelCatalogAliasOverrides(params: {
  rows: readonly NormalizedModelCatalogRow[];
  alias?: ModelCatalogAlias;
}): readonly NormalizedModelCatalogRow[] {
  const alias = params.alias;
  if (!alias) {
    return params.rows;
  }
  return params.rows.map((row) => ({
    ...row,
    ...(alias.api ? { api: alias.api } : {}),
    ...(alias.baseUrl ? { baseUrl: alias.baseUrl } : {}),
  }));
}

export function planManifestModelCatalogSuppressions(params: {
  registry: ManifestModelCatalogRegistry;
  providerFilter?: string;
  modelFilter?: string;
}): ManifestModelCatalogSuppressionPlan {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  const modelFilter = params.modelFilter
    ? normalizeLowercaseStringOrEmpty(params.modelFilter)
    : undefined;
  const suppressions: ManifestModelCatalogSuppressionEntry[] = [];
  for (const plugin of params.registry.plugins) {
    const providerRefs = buildModelCatalogProviderRefs(plugin);
    for (const suppression of plugin.modelCatalog?.suppressions ?? []) {
      const provider = normalizeModelCatalogProviderId(suppression.provider);
      const model = normalizeLowercaseStringOrEmpty(suppression.model);
      if (!provider || !model) {
        continue;
      }
      if (providerFilter && provider !== providerFilter) {
        continue;
      }
      if (modelFilter && model !== modelFilter) {
        continue;
      }
      if (!providerRefs.has(provider)) {
        continue;
      }
      suppressions.push({
        pluginId: plugin.id,
        provider,
        model,
        mergeKey: buildModelCatalogMergeKey(provider, model),
        ...(suppression.reason ? { reason: suppression.reason } : {}),
        ...(suppression.when ? { when: suppression.when } : {}),
      });
    }
  }
  return {
    suppressions: suppressions.toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model) ||
        left.pluginId.localeCompare(right.pluginId),
    ),
  };
}
