import type { OpenClawConfig } from "../config/types.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { resolveInstalledPluginIndexRegistry } from "./installed-plugin-index-registry.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";

export {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
} from "./installed-plugin-index-types.js";
export type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
  InstalledPluginIndexRefreshReason,
  InstalledPluginInstallRecordInfo,
  InstalledPluginPackageChannelInfo,
  InstalledPluginStartupInfo,
  LoadInstalledPluginIndexParams,
  RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
export { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
export { diffInstalledPluginIndexInvalidationReasons } from "./installed-plugin-index-invalidation.js";
export { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

function buildInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & { refreshReason?: InstalledPluginIndexRefreshReason },
): InstalledPluginIndex {
  const env = params.env ?? process.env;
  const { candidates, registry } = resolveInstalledPluginIndexRegistry(params);
  const registryDiagnostics = registry.diagnostics ?? [];
  const diagnostics = [...registryDiagnostics];
  const generatedAtMs = (params.now?.() ?? new Date()).getTime();
  const installRecords = normalizeInstallRecordMap(params.installRecords);
  const plugins = buildInstalledPluginIndexRecords({
    candidates,
    registry,
    config: params.config,
    diagnostics,
    installRecords,
  });

  return {
    version: INSTALLED_PLUGIN_INDEX_VERSION,
    warning: INSTALLED_PLUGIN_INDEX_WARNING,
    hostContractVersion: resolveCompatibilityHostVersion(env),
    compatRegistryVersion: resolveCompatRegistryVersion(),
    migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    generatedAtMs,
    ...(params.refreshReason ? { refreshReason: params.refreshReason } : {}),
    installRecords,
    plugins,
    diagnostics,
  };
}

export function loadInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams = {},
): InstalledPluginIndex {
  return buildInstalledPluginIndex(params);
}

export function refreshInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  return buildInstalledPluginIndex({ ...params, cache: false, refreshReason: params.reason });
}

export function listInstalledPluginRecords(
  index: InstalledPluginIndex,
): readonly InstalledPluginIndexRecord[] {
  return index.plugins;
}

export function listEnabledInstalledPluginRecords(
  index: InstalledPluginIndex,
  config?: OpenClawConfig,
): readonly InstalledPluginIndexRecord[] {
  if (!config) {
    return index.plugins.filter((plugin) => plugin.enabled);
  }
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  return index.plugins.filter(
    (plugin) =>
      resolveEffectiveEnableState({
        id: plugin.pluginId,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: config,
        enabledByDefault: plugin.enabledByDefault,
      }).enabled,
  );
}

export function getInstalledPluginRecord(
  index: InstalledPluginIndex,
  pluginId: string,
): InstalledPluginIndexRecord | undefined {
  return index.plugins.find((plugin) => plugin.pluginId === pluginId);
}

export function isInstalledPluginEnabled(
  index: InstalledPluginIndex,
  pluginId: string,
  config?: OpenClawConfig,
): boolean {
  const record = getInstalledPluginRecord(index, pluginId);
  if (!record) {
    return false;
  }
  if (!config) {
    return record.enabled;
  }
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  return resolveEffectiveEnableState({
    id: record.pluginId,
    origin: record.origin,
    config: normalizedConfig,
    rootConfig: config,
    enabledByDefault: record.enabledByDefault,
  }).enabled;
}
