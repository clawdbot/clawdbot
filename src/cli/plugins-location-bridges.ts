// Bridge builder for users upgrading from bundled plugins to external plugin packages.
import path from "node:path";
import { buildBundledPluginLoadPathAliases } from "../plugins/bundled-load-path-aliases.js";
import type { ExternalizedBundledPluginBridge } from "../plugins/externalized-bundled-plugins.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "../plugins/manifest-registry-installed.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginInstall,
} from "../plugins/official-external-plugin-catalog.js";

type PersistedBundledPluginRecoveryLocation = {
  pluginId: string;
  loadPaths: readonly string[];
};

function buildBridgeFromPersistedBundledRecord(
  record: InstalledPluginIndexRecord,
  manifest?: PluginManifestRecord,
): ExternalizedBundledPluginBridge | null {
  // Relocation is derived from the previous persisted registry, not a hardcoded
  // table. A plugin moving from bundled to npm keeps the same plugin id; the old
  // registry row is the proof that this user actually had it bundled/enabled.
  if (record.origin !== "bundled" || !record.enabled) {
    return null;
  }
  const officialEntry = getOfficialExternalPluginCatalogEntry(record.pluginId);
  const officialInstall = officialEntry
    ? resolveOfficialExternalPluginInstall(officialEntry)
    : null;
  const npmSpec = officialInstall?.npmSpec?.trim() ?? record.packageInstall?.npm?.spec;
  const clawhubSpec = officialInstall?.clawhubSpec?.trim();
  if (!npmSpec && !clawhubSpec) {
    return null;
  }
  const officialChannelId = officialEntry
    ? getOfficialExternalPluginCatalogManifest(officialEntry)?.channel?.id?.trim()
    : undefined;
  const channelIds = manifest?.channels.length
    ? manifest.channels
    : officialChannelId
      ? [officialChannelId]
      : [];
  return {
    bundledPluginId: record.pluginId,
    pluginId: record.pluginId,
    preferredSource:
      officialInstall?.defaultChoice === "clawhub" && clawhubSpec ? "clawhub" : "npm",
    ...(npmSpec ? { npmSpec } : {}),
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(record.enabledByDefault ? { enabledByDefault: true } : {}),
    ...(channelIds.length ? { channelIds } : {}),
  };
}

/** List install bridges inferred from the persisted plugin index before current discovery runs. */
export async function listPersistedBundledPluginLocationBridges(options: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<readonly ExternalizedBundledPluginBridge[]> {
  // This intentionally reads the pre-update registry. The current build may no
  // longer contain the bundled plugin, so normal discovery cannot recover its
  // package install hint.
  const index = await readPersistedInstalledPluginIndex(options);
  if (!index) {
    return [];
  }
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    workspaceDir: options.workspaceDir,
    env: options.env,
    includeDisabled: true,
  });
  const manifestByPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
  return index.plugins.flatMap((record) => {
    const bridge = buildBridgeFromPersistedBundledRecord(
      record,
      manifestByPluginId.get(record.pluginId),
    );
    return bridge ? [bridge] : [];
  });
}

/** List exact previous bundled paths that an explicit plugin reinstall may recover. */
export async function listPersistedBundledPluginRecoveryLocations(options: {
  env?: NodeJS.ProcessEnv;
}): Promise<readonly PersistedBundledPluginRecoveryLocation[]> {
  const index = await readPersistedInstalledPluginIndex(options);
  if (!index) {
    return [];
  }
  return index.plugins.flatMap((record) => {
    const rootDir = record.rootDir.trim();
    if (record.origin !== "bundled" || !path.isAbsolute(rootDir)) {
      return [];
    }
    const loadPaths = Array.from(
      new Set([rootDir, ...buildBundledPluginLoadPathAliases(rootDir).map((alias) => alias.path)]),
    );
    return [{ pluginId: record.pluginId, loadPaths }];
  });
}
