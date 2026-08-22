// Manifest model-catalog planner turns plugin catalog declarations into normalized rows and suppressions.
import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import {
  buildModelCatalogMergeKey,
  normalizeModelCatalogProviderId,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import type {
  ModelCatalog,
  ModelCatalogAlias,
  ModelCatalogDiscovery,
  ModelCatalogModel,
  ModelCatalogProvider,
  NormalizedModelCatalogRow,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeUniqueStringEntries } from "../../packages/normalization-core/src/string-normalization.js";

// Manifest planners convert plugin modelCatalog declarations into normalized
// rows and suppression entries while enforcing plugin ownership boundaries.
type ManifestModelCatalogPlugin = {
  id: string;
  providers?: readonly string[];
  modelCatalog?: Pick<
    ModelCatalog,
    "providers" | "aliases" | "suppressions" | "discovery" | "runtimeAugment"
  >;
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

export type ManifestModelCatalogRowSelection = "static" | "supplemental";

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

function mergeRemoteModelWithTrustedTransport(
  remoteModel: ModelCatalogModel,
  trustedModel: ModelCatalogModel | undefined,
): ModelCatalogModel {
  // Spread keeps an untrusted own `__proto__` key as data instead of invoking
  // Object.prototype's setter while trusted transport fields win explicitly.
  return {
    ...remoteModel,
    ...(trustedModel?.baseUrl ? { baseUrl: trustedModel.baseUrl } : {}),
    ...(trustedModel?.headers ? { headers: trustedModel.headers } : {}),
  };
}

export function planManifestModelCatalogRows(params: {
  registry: ManifestModelCatalogRegistry;
  providerFilter?: string;
  providerFilters?: readonly string[];
  mergeKeyFilter?: ReadonlySet<string>;
  remoteOverlay?: Readonly<Record<string, ModelCatalogProvider>>;
  resolveRemoteProvider?: (provider: string) => ModelCatalogProvider | undefined;
  selection?: ManifestModelCatalogRowSelection;
}): ManifestModelCatalogPlan {
  const hasProviderFilter = Boolean(params.providerFilter) || params.providerFilters !== undefined;
  const providerFilters = hasProviderFilter
    ? new Set(
        normalizeUniqueStringEntries(
          [
            ...(params.providerFilter !== undefined ? [params.providerFilter] : []),
            ...(params.providerFilters ?? []),
          ].map(normalizeModelCatalogProviderId),
        ),
      )
    : undefined;
  const entries: ManifestModelCatalogPlanEntry[] = [];

  for (const plugin of params.registry.plugins) {
    for (const entry of planManifestModelCatalogPluginEntries({
      plugin,
      providerFilters,
      mergeKeyFilter: params.mergeKeyFilter,
      remoteOverlay: params.remoteOverlay,
      resolveRemoteProvider: params.resolveRemoteProvider,
    })) {
      entries.push(entry);
    }
  }

  const rowCandidates: NormalizedModelCatalogRow[] = [];
  const seenRows = new Map<
    string,
    {
      pluginId: string;
      row: NormalizedModelCatalogRow;
      discovery: ModelCatalogDiscovery | undefined;
    }
  >();
  const conflicts = new Map<string, ManifestModelCatalogConflict>();
  for (const entry of entries) {
    for (const row of entry.rows) {
      const seen = seenRows.get(row.mergeKey);
      if (seen) {
        // Conflicting plugin-owned declarations are dropped entirely so no
        // plugin silently wins another plugin's model ref in the merged catalog.
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
      seenRows.set(row.mergeKey, {
        pluginId: entry.pluginId,
        row,
        discovery: entry.discovery,
      });
      rowCandidates.push(row);
    }
  }

  const conflictedMergeKeys = new Set(conflicts.keys());
  const rows = rowCandidates.filter((row) => {
    if (conflictedMergeKeys.has(row.mergeKey)) {
      return false;
    }
    const discovery = seenRows.get(row.mergeKey)?.discovery;
    if (params.selection === "static") {
      return discovery === "static";
    }
    return (
      params.selection !== "supplemental" ||
      discovery !== "runtime" ||
      row.source === "runtime-refresh"
    );
  });

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
  providerFilters: ReadonlySet<string> | undefined;
  mergeKeyFilter: ReadonlySet<string> | undefined;
  remoteOverlay: Readonly<Record<string, ModelCatalogProvider>> | undefined;
  resolveRemoteProvider: ((provider: string) => ModelCatalogProvider | undefined) | undefined;
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
    const plannedProviders = params.providerFilters
      ? normalizeUniqueStringEntries([normalizedProvider, ...providerAliases]).filter(
          (candidateProvider) => params.providerFilters?.has(candidateProvider),
        )
      : [normalizedProvider];
    if (plannedProviders.length === 0) {
      return [];
    }
    const remoteProvider = params.resolveRemoteProvider
      ? params.resolveRemoteProvider(normalizedProvider)
      : params.remoteOverlay?.[normalizedProvider];
    return plannedProviders.flatMap((plannedProvider) => {
      const includesModel = (model: ModelCatalogModel) =>
        !params.mergeKeyFilter ||
        params.mergeKeyFilter.has(buildModelCatalogMergeKey(plannedProvider, model.id));
      const manifestModels = providerCatalog.models.filter(includesModel);
      const remoteModels = remoteProvider?.models.filter(includesModel) ?? [];
      const remoteModelIds = new Set(remoteModels.map((model) => model.id));
      const manifestModelsById = new Map(manifestModels.map((model) => [model.id, model]));
      const providerDefaults = remoteProvider
        ? {
            ...providerCatalog,
            ...remoteProvider,
            ...(providerCatalog.baseUrl ? { baseUrl: providerCatalog.baseUrl } : {}),
            ...(providerCatalog.headers ? { headers: providerCatalog.headers } : {}),
          }
        : providerCatalog;
      const manifestRows = normalizeModelCatalogProviderRows({
        provider: plannedProvider,
        providerCatalog: {
          ...providerDefaults,
          models: manifestModels.filter((model) => !remoteModelIds.has(model.id)),
        },
        source: "manifest",
      });
      const remoteRows = remoteProvider
        ? normalizeModelCatalogProviderRows({
            provider: plannedProvider,
            providerCatalog: {
              ...providerDefaults,
              models: remoteModels.map((model) =>
                mergeRemoteModelWithTrustedTransport(model, manifestModelsById.get(model.id)),
              ),
            },
            source: "runtime-refresh",
          })
        : [];
      const rows = [...manifestRows, ...remoteRows].toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
      );
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
  return new Set(
    normalizeUniqueStringEntries((plugin.providers ?? []).map(normalizeModelCatalogProviderId)),
  );
}

function buildModelCatalogProviderAliasTargets(
  plugin: ManifestModelCatalogPlugin,
): ReadonlyMap<string, readonly string[]> {
  const ownedProviders = buildOwnedProviderSet(plugin);
  const aliasesByTargetProvider = new Map<string, string[]>();
  for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
    const aliasProvider = normalizeModelCatalogProviderId(rawAlias);
    const targetProvider = normalizeModelCatalogProviderId(alias.provider);
    // Aliases are honored only when they point at a provider this plugin owns.
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
      // Suppressions can affect owned providers and their declared aliases only;
      // otherwise one plugin could hide another plugin's catalog entries.
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
