import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizeProviderId } from "./provider-id.js";

export const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";
export const PLUGIN_MODEL_CATALOG_GENERATED_BY = "openclaw-plugin-model-catalog-v1";

export type PluginModelCatalogMetadataSnapshot = Pick<PluginMetadataSnapshot, "owners"> & {
  index?: {
    plugins: ReadonlyArray<{
      enabled: boolean;
      pluginId: string;
    }>;
  };
  normalizePluginId?: (pluginId: string) => string;
};

export type PluginModelCatalogFile = {
  path: string;
  pluginId: string;
  relativePath: string;
};

export function encodePluginModelCatalogRelativePath(pluginId: string): string {
  return `plugins/${encodeURIComponent(pluginId)}/${PLUGIN_MODEL_CATALOG_FILE}`;
}

export function isPluginModelCatalogRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  return (
    !path.isAbsolute(relativePath) &&
    parts.length === 3 &&
    parts[0] === "plugins" &&
    parts[1] !== "" &&
    parts[1] !== "." &&
    parts[1] !== ".." &&
    parts[2] === PLUGIN_MODEL_CATALOG_FILE
  );
}

export function decodePluginModelCatalogRelativePathPluginId(
  relativePath: string,
): string | undefined {
  if (!isPluginModelCatalogRelativePath(relativePath)) {
    return undefined;
  }
  const encodedPluginId = relativePath.split(/[\\/]/)[1];
  try {
    return decodeURIComponent(encodedPluginId);
  } catch {
    return undefined;
  }
}

export function listPluginModelCatalogRelativePaths(agentDir: string): string[] {
  const pluginsDir = path.join(agentDir, "plugins");
  let pluginDirs: Array<import("node:fs").Dirent>;
  try {
    pluginDirs = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return pluginDirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("plugins", entry.name, PLUGIN_MODEL_CATALOG_FILE))
    .filter(isPluginModelCatalogRelativePath)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listPluginModelCatalogFiles(agentDir: string): PluginModelCatalogFile[] {
  return listPluginModelCatalogRelativePaths(agentDir)
    .map((relativePath) => {
      const pluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
      return pluginId
        ? {
            path: path.join(agentDir, relativePath),
            pluginId,
            relativePath,
          }
        : undefined;
    })
    .filter((entry): entry is PluginModelCatalogFile => entry !== undefined)
    .filter((entry) => existsSync(entry.path));
}

export function isGeneratedPluginModelCatalog(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { generatedBy?: unknown }).generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY
  );
}

export function resolvePluginModelCatalogOwnerPluginId(params: {
  providerId: string;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
}): string | undefined {
  const snapshot = params.pluginMetadataSnapshot;
  const owners = snapshot?.owners;
  if (!owners) {
    return undefined;
  }
  const providerId = normalizeProviderId(params.providerId);
  const candidates = [
    owners.modelCatalogProviders.get(providerId),
    owners.providers.get(providerId),
    owners.setupProviders.get(providerId),
  ].find((entry): entry is readonly string[] => Array.isArray(entry) && entry.length > 0);
  const pluginId = candidates?.length === 1 ? candidates[0] : undefined;
  if (!pluginId) {
    return undefined;
  }
  if (!snapshot?.index) {
    return pluginId;
  }
  const normalizedPluginId = snapshot.normalizePluginId?.(pluginId) ?? pluginId;
  return snapshot.index.plugins.some(
    (plugin) => plugin.pluginId === normalizedPluginId && plugin.enabled,
  )
    ? normalizedPluginId
    : undefined;
}

export function filterGeneratedPluginModelCatalogProviders<T>(params: {
  catalogPluginId?: string;
  parsedCatalog?: unknown;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  providers: Record<string, T>;
}): Record<string, T> {
  if (
    !params.catalogPluginId ||
    !params.pluginMetadataSnapshot ||
    (params.parsedCatalog !== undefined && !isGeneratedPluginModelCatalog(params.parsedCatalog))
  ) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(params.providers).filter(([providerId]) => {
      return (
        resolvePluginModelCatalogOwnerPluginId({
          providerId,
          pluginMetadataSnapshot: params.pluginMetadataSnapshot,
        }) === params.catalogPluginId
      );
    }),
  );
}
