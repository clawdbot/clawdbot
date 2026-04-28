import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../../config/config.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "../jiti-loader-cache.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import { shouldPreferNativeJiti } from "../sdk-alias.js";

type PluginRuntimeRecord = {
  origin?: string;
  rootDir?: string;
  source: string;
};

type CachedPluginBoundaryLoaderParams = {
  pluginId: string;
  entryBaseName: string;
  required?: boolean;
  missingLabel?: string;
};

export function readPluginBoundaryConfigSafely() {
  try {
    return getRuntimeConfig();
  } catch {
    return {};
  }
}

export function resolvePluginRuntimeRecord(
  pluginId: string,
  onMissing?: () => never,
): PluginRuntimeRecord | null {
  const manifestRegistry = loadPluginManifestRegistry({
    config: readPluginBoundaryConfigSafely(),
    cache: true,
  });
  const record = manifestRegistry.plugins.find((plugin) => plugin.id === pluginId);
  if (!record?.source) {
    if (onMissing) {
      onMissing();
    }
    return null;
  }
  return {
    ...(record.origin ? { origin: record.origin } : {}),
    rootDir: record.rootDir,
    source: record.source,
  };
}

export function resolvePluginRuntimeRecordByEntryBaseNames(
  entryBaseNames: string[],
  onMissing?: () => never,
): PluginRuntimeRecord | null {
  const manifestRegistry = loadPluginManifestRegistry({
    config: readPluginBoundaryConfigSafely(),
    cache: true,
  });
  const matches = manifestRegistry.plugins.filter((plugin) => {
    if (!plugin?.source) {
      return false;
    }
    const record = {
      rootDir: plugin.rootDir,
      source: plugin.source,
    };
    return entryBaseNames.every(
      (entryBaseName) => resolvePluginRuntimeModulePath(record, entryBaseName) !== null,
    );
  });
  if (matches.length === 0) {
    if (onMissing) {
      onMissing();
    }
    return null;
  }
  if (matches.length > 1) {
    const pluginIds = matches.map((plugin) => plugin.id).join(", ");
    throw new Error(
      `plugin runtime boundary is ambiguous for entries [${entryBaseNames.join(", ")}]: ${pluginIds}`,
    );
  }
  const record = matches[0];
  return {
    ...(record.origin ? { origin: record.origin } : {}),
    rootDir: record.rootDir,
    source: record.source,
  };
}

export function resolvePluginRuntimeModulePath(
  record: Pick<PluginRuntimeRecord, "rootDir" | "source">,
  entryBaseName: string,
  onMissing?: () => never,
): string | null {
  const candidates = [
    path.join(path.dirname(record.source), `${entryBaseName}.js`),
    path.join(path.dirname(record.source), `${entryBaseName}.ts`),
    ...(record.rootDir
      ? [
          path.join(record.rootDir, `${entryBaseName}.js`),
          path.join(record.rootDir, `${entryBaseName}.ts`),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  if (onMissing) {
    onMissing();
  }
  return null;
}

export function getPluginBoundaryJiti(modulePath: string, loaders: PluginJitiLoaderCache) {
  const tryNative = shouldPreferNativeJiti(modulePath);
  return getCachedPluginJitiLoader({
    cache: loaders,
    modulePath,
    importerUrl: import.meta.url,
    jitiFilename: import.meta.url,
    tryNative,
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic plugin boundary loaders use caller-supplied module types.
export function loadPluginBoundaryModuleWithJiti<TModule>(
  modulePath: string,
  loaders: PluginJitiLoaderCache,
): TModule {
  return getPluginBoundaryJiti(modulePath, loaders)(modulePath) as TModule;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic plugin boundary loaders use caller-supplied module types.
export function createCachedPluginBoundaryModuleLoader<TModule>(
  params: CachedPluginBoundaryLoaderParams,
): () => TModule | null {
  let cachedModulePath: string | null = null;
  let cachedModule: TModule | null = null;
  const loaders: PluginJitiLoaderCache = new Map();

  return () => {
    const missingLabel = params.missingLabel ?? `${params.pluginId} plugin runtime`;
    const record = resolvePluginRuntimeRecord(
      params.pluginId,
      params.required
        ? () => {
            throw new Error(`${missingLabel} is unavailable: missing plugin '${params.pluginId}'`);
          }
        : undefined,
    );
    if (!record) {
      return null;
    }
    const modulePath = resolvePluginRuntimeModulePath(
      record,
      params.entryBaseName,
      params.required
        ? () => {
            throw new Error(
              `${missingLabel} is unavailable: missing ${params.entryBaseName} for plugin '${params.pluginId}'`,
            );
          }
        : undefined,
    );
    if (!modulePath) {
      return null;
    }
    if (cachedModule && cachedModulePath === modulePath) {
      return cachedModule;
    }
    const loaded = loadPluginBoundaryModuleWithJiti<TModule>(modulePath, loaders);
    cachedModulePath = modulePath;
    cachedModule = loaded;
    return loaded;
  };
}
