import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeModelCatalogProviderId,
  planManifestModelCatalogRows,
} from "../../model-catalog/index.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "../../plugins/manifest-registry-installed.js";
import {
  getPluginRecord,
  isPluginEnabled,
  loadPluginRegistrySnapshot,
  resolvePluginContributionOwners,
  type PluginRegistrySnapshot,
} from "../../plugins/plugin-registry.js";

function loadStaticManifestCatalogRowsForPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  index: PluginRegistrySnapshot;
  pluginIds: readonly string[];
  providerFilter: string;
}): readonly NormalizedModelCatalogRow[] {
  if (params.pluginIds.length === 0) {
    return [];
  }
  const registry = loadPluginManifestRegistryForInstalledIndex({
    index: params.index,
    config: params.cfg,
    env: params.env,
    pluginIds: params.pluginIds,
  });
  const plan = planManifestModelCatalogRows({
    registry,
    providerFilter: params.providerFilter,
  });
  const staticProviders = new Set(
    plan.entries.filter((entry) => entry.discovery === "static").map((entry) => entry.provider),
  );
  if (staticProviders.size === 0) {
    return [];
  }
  return plan.rows.filter((row) => staticProviders.has(row.provider));
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

export function loadStaticManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter: string;
  env?: NodeJS.ProcessEnv;
}): readonly NormalizedModelCatalogRow[] {
  const providerFilter = normalizeModelCatalogProviderId(params.providerFilter);
  if (!providerFilter) {
    return [];
  }
  const index = loadPluginRegistrySnapshot({
    config: params.cfg,
    env: params.env,
  });
  const conventionRows = loadStaticManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    env: params.env,
    index,
    pluginIds: resolveConventionModelCatalogPluginIds({
      cfg: params.cfg,
      index,
      providerFilter,
    }),
    providerFilter,
  });
  if (conventionRows.length > 0) {
    return conventionRows;
  }
  return loadStaticManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    env: params.env,
    index,
    pluginIds: resolveDeclaredModelCatalogPluginIds({
      cfg: params.cfg,
      index,
      providerFilter,
    }),
    providerFilter,
  });
}
