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
