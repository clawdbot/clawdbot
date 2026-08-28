/** Manifest-backed model catalog row loaders for `openclaw models list`. */
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../../model-catalog/index.js";
import type { ManifestModelCatalogRowSelection } from "../../model-catalog/manifest-planner.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolvePluginContributionOwners } from "../../plugins/plugin-registry-contributions.js";
import {
  getPluginRecord,
  isPluginEnabled,
  type PluginRegistrySnapshot,
} from "../../plugins/plugin-registry-snapshot.js";

function planManifestCatalogRowsForPluginIds(params: {
  cfg: OpenClawConfig;
  registry: PluginManifestRegistry;
  pluginIds?: readonly string[];
  providerFilter?: string;
  selection?: ManifestModelCatalogRowSelection;
}): readonly NormalizedModelCatalogRow[] {
  if (params.pluginIds && params.pluginIds.length === 0) {
    return [];
  }
  const pluginIdSet = params.pluginIds ? new Set(params.pluginIds) : undefined;
  const registry = pluginIdSet
    ? {
        ...params.registry,
        plugins: params.registry.plugins.filter((plugin) => pluginIdSet.has(plugin.id)),
      }
    : params.registry;
  return planEffectiveModelCatalogRows({
    registry,
    config: params.cfg,
    ...(params.providerFilter ? { providerFilter: params.providerFilter } : {}),
    ...(params.selection ? { selection: params.selection } : {}),
  }).rows;
}

function resolveConventionModelCatalogPluginIds(params: {
  cfg: OpenClawConfig;
  index: PluginRegistrySnapshot;
  providerFilter: string;
}): readonly string[] {
  const record = getPluginRecord({
    index: params.index,
    pluginId: params.providerFilter,
  });
  if (
    !record ||
    !isPluginEnabled({
      index: params.index,
      pluginId: record.pluginId,
      config: params.cfg,
    })
  ) {
    return [];
  }
  return [record.pluginId];
}

function resolveDeclaredModelCatalogPluginIds(params: {
  cfg: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  providerFilter: string;
}): readonly string[] {
  return resolvePluginContributionOwners({
    lookUpTable: params.snapshot,
    config: params.cfg,
    contribution: "modelCatalogProviders",
    matches: params.providerFilter,
  });
}

function resolveModelCatalogPluginIdsForProvider(params: {
  cfg: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  provider: string;
}): readonly string[] {
  return [
    ...new Set([
      ...resolveConventionModelCatalogPluginIds({
        cfg: params.cfg,
        index: params.snapshot.index,
        providerFilter: params.provider,
      }),
      ...resolveDeclaredModelCatalogPluginIds({
        cfg: params.cfg,
        snapshot: params.snapshot,
        providerFilter: params.provider,
      }),
    ]),
  ];
}

/**
 * Resolves provider ownership and whether static manifest rows require runtime
 * augmentation before they can be treated as complete catalog coverage.
 */
export function resolveManifestCatalogCoverageForList(params: {
  cfg: OpenClawConfig;
  providerIds: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): {
  ownedProviderIds: ReadonlySet<string>;
  completeProviderIds: ReadonlySet<string>;
} {
  const snapshot =
    params.metadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
    });
  const ownedProviderIds = new Set<string>();
  const completeProviderIds = new Set<string>();
  for (const rawProvider of params.providerIds) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider) {
      continue;
    }
    const pluginIds = resolveModelCatalogPluginIdsForProvider({
      cfg: params.cfg,
      snapshot,
      provider,
    });
    if (pluginIds.length === 0) {
      continue;
    }
    ownedProviderIds.add(provider);
    const complete = pluginIds.every((pluginId) => {
      const plugin = snapshot.byPluginId.get(pluginId);
      if (!plugin) {
        return false;
      }
      if (plugin.modelCatalog?.runtimeAugment === true || plugin.origin !== "bundled") {
        return false;
      }
      const aliasTarget = plugin.modelCatalog?.aliases?.[provider]?.provider;
      const discoveryProvider = normalizeProviderId(aliasTarget ?? provider);
      return plugin.modelCatalog?.discovery?.[discoveryProvider] === "static";
    });
    if (complete) {
      completeProviderIds.add(provider);
    }
  }
  if (params.cfg.models?.mode === "replace") {
    for (const provider of params.providerIds) {
      completeProviderIds.add(normalizeProviderId(provider));
    }
  }
  return { ownedProviderIds, completeProviderIds };
}

function loadManifestCatalogRowsForListSelection(params: {
  cfg: OpenClawConfig;
  providerFilter?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  selection?: ManifestModelCatalogRowSelection;
}): readonly NormalizedModelCatalogRow[] {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  const snapshot =
    params.metadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
    });
  if (!providerFilter) {
    return planManifestCatalogRowsForPluginIds({
      cfg: params.cfg,
      registry: snapshot.manifestRegistry,
      ...(params.selection ? { selection: params.selection } : {}),
    });
  }
  const conventionRows = planManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    registry: snapshot.manifestRegistry,
    pluginIds: resolveConventionModelCatalogPluginIds({
      cfg: params.cfg,
      index: snapshot.index,
      providerFilter,
    }),
    providerFilter,
    ...(params.selection ? { selection: params.selection } : {}),
  });
  if (conventionRows.length > 0) {
    return conventionRows;
  }
  return planManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    registry: snapshot.manifestRegistry,
    pluginIds: resolveDeclaredModelCatalogPluginIds({
      cfg: params.cfg,
      snapshot,
      providerFilter,
    }),
    providerFilter,
    ...(params.selection ? { selection: params.selection } : {}),
  });
}

/** Loads manifest catalog rows without importing provider runtimes. */
export function loadManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): readonly NormalizedModelCatalogRow[] {
  return loadManifestCatalogRowsForListSelection(params);
}

/** Loads authoritative static manifest catalog rows for model-list output. */
export function loadStaticManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): readonly NormalizedModelCatalogRow[] {
  return loadManifestCatalogRowsForListSelection({ ...params, selection: "static" });
}
