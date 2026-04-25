import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledPluginCompatibleLoadValues } from "./activation-context.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import { loadBundledDocumentExtractorEntriesFromDir } from "./document-extractor-public-artifacts.js";
import type { PluginDocumentExtractorEntry } from "./document-extractor-types.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

function compareExtractors(
  left: PluginDocumentExtractorEntry,
  right: PluginDocumentExtractorEntry,
): number {
  const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

function resolveBundledDocumentExtractorCompatPluginIds(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): string[] {
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        (plugin.contracts?.documentExtractors?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveEnabledBundledDocumentExtractorPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): PluginManifestRecord[] {
  if (params.config?.plugins?.enabled === false) {
    return [];
  }

  const activation = resolveBundledPluginCompatibleLoadValues({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: params.onlyPluginIds,
    applyAutoEnable: true,
    compatMode: {
      allowlist: false,
      enablement: "allowlist",
      vitest: true,
    },
    resolveCompatPluginIds: resolveBundledDocumentExtractorCompatPluginIds,
  });
  const normalizedPlugins = normalizePluginsConfig(activation.config?.plugins);
  const activationSource = createPluginActivationSource({
    config: activation.activationSourceConfig,
  });
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return loadPluginManifestRegistry({
    config: activation.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  }).plugins.filter((plugin) => {
    if (
      plugin.origin !== "bundled" ||
      (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) ||
      (plugin.contracts?.documentExtractors?.length ?? 0) === 0
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

function resolveExplicitAllowedDocumentExtractorPluginIds(params: {
  config?: OpenClawConfig;
  onlyPluginIds?: readonly string[];
}): string[] | null {
  const allow = params.config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return null;
  }
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  const deniedPluginIds = new Set(params.config?.plugins?.deny ?? []);
  const entries = params.config?.plugins?.entries ?? {};
  return [
    ...new Set(
      allow
        .map((pluginId) => pluginId.trim())
        .filter(Boolean)
        .filter((pluginId) => !onlyPluginIdSet || onlyPluginIdSet.has(pluginId))
        .filter((pluginId) => !deniedPluginIds.has(pluginId))
        .filter((pluginId) => entries[pluginId]?.enabled !== false),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function resolvePluginDocumentExtractors(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): PluginDocumentExtractorEntry[] {
  const extractors: PluginDocumentExtractorEntry[] = [];
  const loadErrors: unknown[] = [];
  const explicitAllowedPluginIds = resolveExplicitAllowedDocumentExtractorPluginIds({
    config: params?.config,
    onlyPluginIds: params?.onlyPluginIds,
  });
  const pluginIds =
    explicitAllowedPluginIds ??
    resolveEnabledBundledDocumentExtractorPlugins({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
      onlyPluginIds: params?.onlyPluginIds,
    }).map((plugin) => plugin.id);
  for (const pluginId of pluginIds) {
    let loaded: PluginDocumentExtractorEntry[] | null;
    try {
      loaded = loadBundledDocumentExtractorEntriesFromDir({
        dirName: pluginId,
        pluginId,
      });
    } catch (error) {
      loadErrors.push(error);
      continue;
    }
    if (loaded) {
      extractors.push(...loaded);
    }
  }
  if (extractors.length === 0 && loadErrors.length > 0) {
    throw new Error("Unable to load document extractor plugins", {
      cause: loadErrors.length === 1 ? loadErrors[0] : new AggregateError(loadErrors),
    });
  }
  return extractors.toSorted(compareExtractors);
}
