import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCandidate } from "./discovery.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import type { BundledChannelConfigCollector } from "./manifest-registry.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  type OpenClawPackageManifest,
  type PackageManifest,
} from "./manifest.js";

function resolveInstalledPluginRootDir(record: InstalledPluginIndexRecord): string {
  return record.rootDir || path.dirname(record.manifestPath || process.cwd());
}

function resolveFallbackPluginSource(record: InstalledPluginIndexRecord): string {
  const rootDir = resolveInstalledPluginRootDir(record);
  for (const entry of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
    const candidate = path.join(rootDir, entry);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(rootDir, DEFAULT_PLUGIN_ENTRY_CANDIDATES[0]);
}

function resolveInstalledPackageManifest(
  record: InstalledPluginIndexRecord,
): OpenClawPackageManifest | undefined {
  if (!record.packageChannel) {
    return undefined;
  }
  if (record.packageChannel.commands) {
    return { channel: record.packageChannel };
  }
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageJsonPath = record.packageJson?.path
    ? path.resolve(rootDir, record.packageJson.path)
    : undefined;
  if (!packageJsonPath) {
    return { channel: record.packageChannel };
  }
  const relative = path.relative(rootDir, packageJsonPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { channel: record.packageChannel };
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageManifest;
    const packageManifest = getPackageManifestMetadata(packageJson);
    return {
      channel: {
        ...record.packageChannel,
        ...(packageManifest?.channel?.commands
          ? { commands: packageManifest.channel.commands }
          : {}),
      },
    };
  } catch {
    return { channel: record.packageChannel };
  }
}

function toPluginCandidate(record: InstalledPluginIndexRecord): PluginCandidate {
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageManifest = resolveInstalledPackageManifest(record);
  return {
    idHint: record.pluginId,
    source: record.source ?? resolveFallbackPluginSource(record),
    ...(record.setupSource ? { setupSource: record.setupSource } : {}),
    rootDir,
    origin: record.origin,
    ...(record.format ? { format: record.format } : {}),
    ...(record.bundleFormat ? { bundleFormat: record.bundleFormat } : {}),
    ...(record.packageName ? { packageName: record.packageName } : {}),
    ...(record.packageVersion ? { packageVersion: record.packageVersion } : {}),
    ...(packageManifest ? { packageManifest } : {}),
    packageDir: rootDir,
  };
}

export function loadPluginManifestRegistryForInstalledIndex(params: {
  index: InstalledPluginIndex;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  includeDisabled?: boolean;
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
}): PluginManifestRegistry {
  if (params.pluginIds && params.pluginIds.length === 0) {
    return { plugins: [], diagnostics: [] };
  }
  const pluginIdSet = params.pluginIds?.length ? new Set(params.pluginIds) : null;
  const diagnostics = pluginIdSet
    ? params.index.diagnostics.filter((diagnostic) => {
        const pluginId = diagnostic.pluginId;
        return !pluginId || pluginIdSet.has(pluginId);
      })
    : params.index.diagnostics;
  const candidates = params.index.plugins
    .filter((plugin) => params.includeDisabled || plugin.enabled)
    .filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.pluginId))
    .map(toPluginCandidate);
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: false,
    candidates,
    diagnostics: [...diagnostics],
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(params.index),
    ...(params.bundledChannelConfigCollector
      ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
      : {}),
  });
}
