import type { ExternalizedBundledPluginBridge } from "../plugins/externalized-bundled-plugins.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "../plugins/manifest-registry-installed.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";

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
  const npmSpec = record.packageInstall?.npm?.spec;
  if (!npmSpec) {
    return null;
  }
  return {
    bundledPluginId: record.pluginId,
    pluginId: record.pluginId,
    preferredSource: "npm",
    npmSpec,
    ...(record.enabledByDefault ? { enabledByDefault: true } : {}),
    ...(manifest?.channels.length ? { channelIds: manifest.channels } : {}),
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
