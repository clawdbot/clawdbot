import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { loadBundledDocumentExtractorEntriesFromDir } from "./document-extractor-public-artifacts.js";
import type { PluginDocumentExtractorEntry } from "./document-extractor-types.js";

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
    resolveEnabledBundledManifestContractPlugins({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
      onlyPluginIds: params?.onlyPluginIds,
      contract: "documentExtractors",
      compatMode: {
        allowlist: false,
        enablement: "allowlist",
        vitest: true,
      },
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
