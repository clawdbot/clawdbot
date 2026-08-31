/** Public installed-plugin-index API for load, refresh, policy hash, and invalidation checks. */
import type { OpenClawConfig } from "../config/types.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { isBundledProviderCompatPlugin } from "./bundled-provider-compat.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
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
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";

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
  LoadInstalledPluginIndexParams,
  RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
export { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
export { diffInstalledPluginIndexInvalidationReasons } from "./installed-plugin-index-invalidation.js";
export { hasMissingConfigPathActivationMetadata } from "./installed-plugin-index-config-path-scope.js";
export { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

function buildInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & { refreshReason?: InstalledPluginIndexRefreshReason },
): {
  index: InstalledPluginIndex;
  discovery: PluginDiscoveryResult | undefined;
  manifestRegistry: PluginManifestRegistry;
} {
  const env = params.env ?? process.env;
  const installRecords = normalizeInstallRecordMap(
    params.installRecords ??
      loadInstalledPluginIndexInstallRecordsSync({
        env,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
        ...(params.pluginIndexFilePath ? { filePath: params.pluginIndexFilePath } : {}),
      }),
  );
  const baseDiscovery = params.candidates
    ? { candidates: params.candidates, diagnostics: params.diagnostics ?? [] }
    : (params.discovery ??
      discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalizePluginsConfig(params.config?.plugins).loadPaths,
        env,
        installRecords,
      }));
  const discovery =
    !params.candidates && params.diagnostics?.length
      ? {
          ...baseDiscovery,
          diagnostics: [...baseDiscovery.diagnostics, ...params.diagnostics],
        }
      : baseDiscovery;
  const registry = loadPluginManifestRegistryCore({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    installRecords,
  });
  const diagnostics = [...(registry.diagnostics ?? [])];
  const generatedAtMs = (params.now?.() ?? new Date()).getTime();
  const activationConfig = withBundledPluginEnablementCompat({
    config: params.config,
    env,
    pluginIds: registry.plugins.filter(isBundledProviderCompatPlugin).map((plugin) => plugin.id),
    activation: "defaults",
  });
  const plugins = buildInstalledPluginIndexRecords({
    candidates: discovery.candidates,
    registry,
    config: activationConfig,
    env,
    diagnostics,
    installRecords,
  });

  return {
    index: {
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      warning: INSTALLED_PLUGIN_INDEX_WARNING,
      hostContractVersion: resolveCompatibilityHostVersion(env),
      compatRegistryVersion: resolveCompatRegistryVersion(),
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config, env),
      generatedAtMs,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.refreshReason ? { refreshReason: params.refreshReason } : {}),
      installRecords,
      plugins,
      diagnostics,
    },
    discovery: params.candidates ? undefined : discovery,
    manifestRegistry: registry,
  };
}

export function loadInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams = {},
): InstalledPluginIndex {
  return buildInstalledPluginIndex(params).index;
}

export function loadInstalledPluginIndexWithDiscovery(
  params: LoadInstalledPluginIndexParams = {},
): {
  index: InstalledPluginIndex;
  discovery: PluginDiscoveryResult | undefined;
  manifestRegistry: PluginManifestRegistry;
} {
  return buildInstalledPluginIndex(params);
}

/** True when a persisted index cannot represent the requested workspace discovery scope. */
export function hasInstalledPluginIndexWorkspaceScopeMismatch(
  index: InstalledPluginIndex,
  workspaceDir: string | undefined,
): boolean {
  if (workspaceDir !== undefined) {
    return index.workspaceDir !== workspaceDir;
  }
  return (
    index.workspaceDir !== undefined ||
    index.plugins.some((plugin) => plugin.origin === "workspace")
  );
}

export function refreshInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  return buildInstalledPluginIndex({ ...params, refreshReason: params.reason }).index;
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
  env?: NodeJS.ProcessEnv,
): boolean {
  const record = getInstalledPluginRecord(index, pluginId);
  if (!record) {
    return false;
  }
  if (!config) {
    return record.enabled;
  }
  const activationConfig = withBundledPluginEnablementCompat({
    config,
    env,
    pluginIds: isBundledProviderCompatPlugin({
      origin: record.origin,
      providers: record.contributions?.providers,
      contracts: record.contributions?.contracts,
    })
      ? [record.pluginId]
      : [],
    activation: "defaults",
  });
  const normalizedConfig = normalizePluginsConfig(activationConfig?.plugins);
  const state = resolveEffectivePluginActivationState({
    id: record.pluginId,
    origin: record.origin,
    config: normalizedConfig,
    rootConfig: activationConfig,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
  });
  // The index records startup policy; current activation is evaluated against
  // the same package facts without making the startup enablement sticky.
  return state.enabled;
}
