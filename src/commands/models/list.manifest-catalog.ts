import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeModelCatalogProviderId,
  planManifestModelCatalogRows,
} from "../../model-catalog/index.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import {
  getPluginRecord,
  isPluginEnabled,
  resolvePluginContributionOwners,
  type PluginRegistrySnapshot,
} from "../../plugins/plugin-registry.js";

type ManifestCatalogRowsForListMode = "static-authoritative" | "supplemental";

function loadManifestCatalogRowsForPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  index: PluginRegistrySnapshot;
  registry: PluginManifestRegistry;
  mode: ManifestCatalogRowsForListMode;
  pluginIds?: readonly string[];
  providerFilter?: string;
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
  const plan = planManifestModelCatalogRows({
    registry,
    ...(params.providerFilter ? { providerFilter: params.providerFilter } : {}),
  });
  const eligibleProviders = new Set(
    plan.entries
      .filter((entry) =>
        params.mode === "static-authoritative"
          ? entry.discovery === "static"
          : entry.discovery !== "runtime",
      )
      .map((entry) => entry.provider),
  );
  if (eligibleProviders.size === 0) {
    return [];
  }
  return plan.rows.filter((row) => eligibleProviders.has(row.provider));
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

function loadManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter?: string;
  env?: NodeJS.ProcessEnv;
  mode?: ManifestCatalogRowsForListMode;
}): readonly NormalizedModelCatalogRow[] {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  const mode = params.mode ?? "static-authoritative";
  const snapshot = loadManifestMetadataSnapshot({
    config: params.cfg,
    env: params.env ?? process.env,
  });
  const index = snapshot.index;
  if (!providerFilter) {
    return loadManifestCatalogRowsForPluginIds({
      cfg: params.cfg,
      env: params.env,
      index,
      registry: snapshot.manifestRegistry,
      mode,
    });
  }
  const conventionRows = loadManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    env: params.env,
    index,
    registry: snapshot.manifestRegistry,
    mode,
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
  return loadManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    env: params.env,
    index,
    registry: snapshot.manifestRegistry,
    mode,
    pluginIds: resolveDeclaredModelCatalogPluginIds({
      cfg: params.cfg,
      index,
      providerFilter,
    }),
    providerFilter,
  });
}

export function loadStaticManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter?: string;
  env?: NodeJS.ProcessEnv;
}): readonly NormalizedModelCatalogRow[] {
  return loadManifestCatalogRowsForList({
    ...params,
    mode: "static-authoritative",
  });
}

export function loadSupplementalManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter?: string;
  env?: NodeJS.ProcessEnv;
}): readonly NormalizedModelCatalogRow[] {
  return loadManifestCatalogRowsForList({
    ...params,
    mode: "supplemental",
  });
}
