/** Manifest-backed model catalog row loaders for `openclaw models list`. */
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
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
  index: PluginRegistrySnapshot;
  providerFilter: string;
}): readonly string[] {
  return resolvePluginContributionOwners({
    index: params.index,
    config: params.cfg,
    contribution: "modelCatalogProviders",
    matches: params.providerFilter,
  });
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
  const index = snapshot.index;
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
      index,
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
      index,
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
