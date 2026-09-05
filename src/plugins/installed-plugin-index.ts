/** Public installed-plugin-index API for load, refresh, policy hash, and invalidation checks. */
import type { OpenClawConfig } from "../config/types.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { isBundledProviderCompatPlugin } from "./bundled-provider-compat.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
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
    registryPath: resolveInstalledPluginIndexStorePath({
      env,
      stateDir: params.stateDir,
      filePath: params.pluginIndexFilePath,
    }),
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
  if (!record || !config) {
    return record?.enabled ?? false;
  }
  return createInstalledPluginEnabledPredicate([record], config, env)(pluginId);
}

function isInstalledBundledProvider(record: InstalledPluginIndexRecord): boolean {
  return isBundledProviderCompatPlugin({
    origin: record.origin,
    providers: record.contributions?.providers,
    contracts: record.contributions?.contracts,
  });
}

/** Prepare live policy for one synchronous operation, never across config/root changes. */
export function createInstalledPluginEnabledPredicate(
  plugins: readonly InstalledPluginIndexRecord[],
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): (pluginId: string) => boolean {
  let source: PluginActivationConfigSource | undefined;
  let bundledSource: PluginActivationConfigSource | undefined;
  let records: Map<string, InstalledPluginIndexRecord> | undefined;
  return (pluginId) => {
    if (!records) {
      records = new Map();
      // Inventory is fixed for this operation; retain the first duplicate like find().
      for (const entry of plugins) {
        if (!records.has(entry.pluginId)) {
          records.set(entry.pluginId, entry);
        }
      }
    }
    const record = records.get(pluginId);
    if (!record || !config) {
      return record?.enabled ?? false;
    }
    let activationSource: PluginActivationConfigSource;
    if (isInstalledBundledProvider(record)) {
      if (!bundledSource) {
        const bundledConfig = withBundledPluginEnablementCompat({
          config,
          env,
          pluginIds: plugins.filter(isInstalledBundledProvider).map((entry) => entry.pluginId),
          activation: "defaults",
        });
        // Provider compat may extend an allowlist; non-provider owners must retain the original.
        bundledSource =
          bundledConfig === config
            ? (source ??= createPluginActivationSource({ config }))
            : createPluginActivationSource({ config: bundledConfig });
      }
      activationSource = bundledSource;
    } else {
      activationSource = source ??= createPluginActivationSource({ config });
    }
    return resolveEffectivePluginActivationState({
      id: record.pluginId,
      origin: record.origin,
      channelIds: record.contributions?.channels,
      config: activationSource.plugins,
      rootConfig: activationSource.rootConfig,
      activationSource,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
    }).enabled;
  };
}
