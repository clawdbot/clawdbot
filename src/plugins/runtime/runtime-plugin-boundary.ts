// Runtime plugin boundary helpers enforce package and source boundaries for runtime loading.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { getRuntimeConfig } from "../../config/config.js";
import { loadPluginManifestRegistryCore } from "../manifest-registry.js";
import {
  isJavaScriptModulePath,
  tryNativeRequireJavaScriptModule,
} from "../native-module-require.js";
import { pluginCacheExistsSync } from "../plugin-cache-files.js";
import { getPluginCacheRoot, getPluginCacheSource } from "../plugin-cache.js";
import {
  getCachedPluginSourceModuleLoader,
  recordPluginModuleRoot,
} from "../plugin-module-loader-cache.js";
import type { PluginOrigin } from "../plugin-origin.types.js";

type PluginRuntimeRecord = {
  origin?: PluginOrigin;
  rootDir?: string;
  source: string;
};

function readPluginBoundaryConfigSafely() {
  try {
    return getRuntimeConfig();
  } catch {
    return {};
  }
}
export function resolvePluginRuntimeRecordByEntryBaseNames(
  entryBaseNames: string[],
  onMissing?: () => never,
): PluginRuntimeRecord | null {
  const manifestRegistry = loadPluginManifestRegistryCore({
    config: readPluginBoundaryConfigSafely(),
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
  const record = expectDefined(matches[0], "matches capture group 0");
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
  const rootDir = record.rootDir ?? path.dirname(record.source);
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const key = `runtime-boundary:${record.source}:${entryBaseName}`;
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    if (!cached && onMissing) {
      onMissing();
    }
    return cached?.modulePath ?? null;
  }
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
    if (pluginCacheExistsSync(candidate)) {
      artifacts.set(key, { modulePath: candidate, boundaryRoot: rootDir });
      return candidate;
    }
  }
  artifacts.set(key, null);
  if (onMissing) {
    onMissing();
  }
  return null;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic plugin boundary loaders use caller-supplied module types.
export function loadPluginBoundaryModule<TModule>(
  modulePath: string,
  options: { origin?: PluginOrigin; rootDir?: string } = {},
): TModule {
  const source = getPluginCacheSource(modulePath);
  const key = options.origin === "bundled" ? "bundled-runtime-boundary" : "runtime-boundary";
  const cached = source.variants.get(key)?.exports;
  if (cached) {
    // SAFETY: This slot contains the same module exports and execution mode returned below; callers own the module-shape contract.
    return cached.value as TModule;
  }
  recordPluginModuleRoot(modulePath, options.rootDir ?? path.dirname(modulePath));
  if (isJavaScriptModulePath(modulePath)) {
    const native = tryNativeRequireJavaScriptModule(modulePath, {
      allowWindows: true,
      fallbackOnNativeError: options.origin !== "bundled",
    });
    if (native.ok) {
      source.variants.set(key, { exports: { value: native.moduleExport } });
      return native.moduleExport as TModule;
    }
    if (options.origin === "bundled") {
      throw new Error(`bundled plugin runtime module must load natively: ${modulePath}`);
    }
  } else if (options.origin === "bundled") {
    throw new Error(`bundled plugin runtime module must be built JavaScript: ${modulePath}`);
  }

  return getCachedPluginSourceModuleLoader({
    modulePath,
    rootDir: options.rootDir,
    importerUrl: import.meta.url,
    loaderFilename: import.meta.url,
  })(modulePath) as TModule;
}
