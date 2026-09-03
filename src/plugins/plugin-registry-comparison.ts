import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
} from "./installed-plugin-index-types.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import type { PluginRegistryDifference } from "./plugin-registry-snapshot.types.js";

export function isContainedPluginPath(
  rootPath: string,
  targetPath: string,
  cache: Map<string, string>,
): boolean {
  // Project unresolved suffixes from the nearest real ancestor so missing disabled
  // artifacts stay inspectable without accepting symlink or path-alias escapes.
  const resolveProjectedPath = (inputPath: string): string | null => {
    const target = path.resolve(inputPath);
    for (let cursor = target; ; cursor = path.dirname(cursor)) {
      try {
        fs.lstatSync(cursor);
        const realCursor = safeRealpathSync(cursor, cache);
        return realCursor ? path.resolve(realCursor, path.relative(cursor, target)) : null;
      } catch {
        if (cursor === path.dirname(cursor)) {
          return null;
        }
      }
    }
  };
  const root = resolveProjectedPath(rootPath);
  const target = resolveProjectedPath(targetPath);
  return Boolean(root && target && isPathInside(root, target));
}

function resolvePluginRegistryRecordContent(
  plugin: InstalledPluginIndexRecord,
  comparePackageJsonPath: boolean,
): unknown {
  const {
    doctorContractFile: _doctorContractFile,
    manifestFile: _manifestFile,
    packageBuild,
    packageJson,
    ...record
  } = plugin;
  // Only bundledDist changes runtime artifact selection. The store drops other build metadata,
  // so omit packageBuild when bundledDist is undeclared or legacy rows report false drift.
  const stableRecord = Object.assign(
    record,
    packageBuild?.bundledDist === undefined
      ? {}
      : { packageBuild: { bundledDist: packageBuild.bundledDist } },
  );
  if (!packageJson || !comparePackageJsonPath) {
    return stableRecord;
  }
  const {
    fileSignature: _fileSignature,
    path: packageJsonPath,
    ...stablePackageJson
  } = packageJson;
  return Object.assign(stableRecord, {
    packageJson: Object.assign(stablePackageJson, { path: packageJsonPath }),
  });
}

export function resolvePluginRegistryContent(
  index: InstalledPluginIndex,
  comparePackageJsonPath: boolean,
  excludedPlugins?: ReadonlyMap<string, string>,
): unknown {
  const {
    generatedAtMs: _generatedAtMs,
    refreshReason: _refreshReason,
    warning: _warning,
    ...content
  } = index;
  const excludedRoots = [...(excludedPlugins?.values() ?? [])].map((root) => path.resolve(root));
  const exclusionPathCache = new Map<string, string>();
  return {
    ...content,
    diagnostics: excludedPlugins
      ? content.diagnostics.filter(
          (diagnostic) =>
            !(
              (diagnostic.pluginId && excludedPlugins.has(diagnostic.pluginId)) ||
              (diagnostic.source &&
                excludedRoots.some((root) =>
                  isContainedPluginPath(root, diagnostic.source!, exclusionPathCache),
                ))
            ),
        )
      : content.diagnostics,
    installRecords: excludedPlugins
      ? Object.fromEntries(
          Object.entries(content.installRecords).filter(
            ([pluginId]) => !excludedPlugins.has(pluginId),
          ),
        )
      : content.installRecords,
    plugins: content.plugins
      .filter((plugin) => !excludedPlugins?.has(plugin.pluginId))
      .map((plugin) => resolvePluginRegistryRecordContent(plugin, comparePackageJsonPath)),
  };
}

export function diffPluginRegistryRecords(
  persisted: InstalledPluginIndex,
  derived: InstalledPluginIndex,
  comparePackageJsonPath: boolean,
  excludedPlugins: ReadonlyMap<string, string>,
): PluginRegistryDifference[] {
  // Attribute the same normalized record, install, and diagnostic facts that can make the
  // whole registry stale. Reporting a narrower comparison would hide the owning plugin.
  const persistedPlugins = new Map(persisted.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const derivedPlugins = new Map(derived.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const pluginIds = new Set([
    ...persistedPlugins.keys(),
    ...derivedPlugins.keys(),
    ...Object.keys(persisted.installRecords),
    ...Object.keys(derived.installRecords),
    ...persisted.diagnostics.flatMap((diagnostic) =>
      diagnostic.pluginId ? [diagnostic.pluginId] : [],
    ),
    ...derived.diagnostics.flatMap((diagnostic) =>
      diagnostic.pluginId ? [diagnostic.pluginId] : [],
    ),
  ]);
  return [...pluginIds]
    .filter((pluginId) => !excludedPlugins.has(pluginId))
    .toSorted((left, right) => left.localeCompare(right))
    .flatMap((pluginId) => {
      const persistedPlugin = persistedPlugins.get(pluginId);
      const derivedPlugin = derivedPlugins.get(pluginId);
      const persistedContent = [
        persistedPlugin
          ? resolvePluginRegistryRecordContent(persistedPlugin, comparePackageJsonPath)
          : undefined,
        persisted.installRecords[pluginId],
        persisted.diagnostics.filter((diagnostic) => diagnostic.pluginId === pluginId),
      ];
      const derivedContent = [
        derivedPlugin
          ? resolvePluginRegistryRecordContent(derivedPlugin, comparePackageJsonPath)
          : undefined,
        derived.installRecords[pluginId],
        derived.diagnostics.filter((diagnostic) => diagnostic.pluginId === pluginId),
      ];
      return isDeepStrictEqual(persistedContent, derivedContent)
        ? []
        : [
            {
              pluginId,
              persistedSource: persistedPlugin?.source ?? persistedPlugin?.manifestPath ?? null,
              derivedSource: derivedPlugin?.source ?? derivedPlugin?.manifestPath ?? null,
            },
          ];
    });
}
