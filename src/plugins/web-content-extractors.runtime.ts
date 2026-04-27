import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledPluginCompatibleLoadValues } from "./activation-context.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import { loadBundledWebContentExtractorEntriesFromDir } from "./web-content-extractor-public-artifacts.js";
import type { PluginWebContentExtractorEntry } from "./web-content-extractor-types.js";

function compareExtractors(
  left: PluginWebContentExtractorEntry,
  right: PluginWebContentExtractorEntry,
): number {
  const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

function listWebContentExtractorPluginIds(params: {
  plugins: readonly PluginManifestRecord[];
  onlyPluginIds?: readonly string[];
}): string[] {
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return params.plugins
    .filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        (plugin.contracts?.webContentExtractors?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function loadWebContentExtractorManifestRecords(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): readonly PluginManifestRecord[] {
  return loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  }).plugins;
}

function resolveEnabledBundledExtractorPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): PluginManifestRecord[] {
  if (params.config?.plugins?.enabled === false) {
    return [];
  }
  let manifestRecords: readonly PluginManifestRecord[] | undefined;
  const loadManifestRecords = (config?: OpenClawConfig) => {
    manifestRecords ??= loadWebContentExtractorManifestRecords({
      config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
    return manifestRecords;
  };

  const activation = resolveBundledPluginCompatibleLoadValues({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: params.onlyPluginIds,
    applyAutoEnable: true,
    compatMode: {
      allowlist: true,
      enablement: "always",
      vitest: true,
    },
    resolveCompatPluginIds: (compatParams) =>
      listWebContentExtractorPluginIds({
        plugins: loadManifestRecords(compatParams.config),
        onlyPluginIds: compatParams.onlyPluginIds,
      }),
  });
  const normalizedPlugins = normalizePluginsConfig(activation.config?.plugins);
  const activationSource = createPluginActivationSource({
    config: activation.activationSourceConfig,
  });
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return loadManifestRecords(activation.config).filter((plugin) => {
    if (
      plugin.origin !== "bundled" ||
      (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) ||
      (plugin.contracts?.webContentExtractors?.length ?? 0) === 0
    ) {
      return false;
    }
    return resolveEffectivePluginActivationState({
      id: plugin.id,
      origin: plugin.origin,
      config: normalizedPlugins,
      rootConfig: activation.config,
      enabledByDefault: plugin.enabledByDefault,
      activationSource,
    }).enabled;
  });
}

export function resolvePluginWebContentExtractors(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): PluginWebContentExtractorEntry[] {
  const extractors: PluginWebContentExtractorEntry[] = [];
  for (const plugin of resolveEnabledBundledExtractorPlugins({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
    onlyPluginIds: params?.onlyPluginIds,
  })) {
    const loaded = loadBundledWebContentExtractorEntriesFromDir({
      dirName: plugin.id,
      pluginId: plugin.id,
    });
    if (loaded) {
      extractors.push(...loaded);
    }
  }
  return extractors.toSorted(compareExtractors);
}
