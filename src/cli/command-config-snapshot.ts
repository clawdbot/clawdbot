// CLI-owned config reads publish one complete metadata generation for later command consumers.
import { readConfigFileSnapshotWithPluginMetadata } from "../config/config.js";
import { adoptCurrentPluginMetadataSnapshotIfAbsent } from "../plugins/current-plugin-metadata-snapshot.js";
import { completePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

/** Reads full command config and adopts its metadata without replacing an existing owner. */
export async function readCommandConfigSnapshot(options?: {
  observe?: boolean;
  skipPluginValidation?: boolean;
}) {
  const read = await readConfigFileSnapshotWithPluginMetadata(options);
  const pluginMetadataSnapshot = completePluginMetadataSnapshot({
    snapshot: read.pluginMetadataSnapshot,
    config: read.snapshot.sourceConfig,
    env: process.env,
    workspaceDir: read.pluginMetadataSnapshot?.workspaceDir,
  });
  if (pluginMetadataSnapshot) {
    adoptCurrentPluginMetadataSnapshotIfAbsent(pluginMetadataSnapshot, {
      config: read.snapshot.sourceConfig,
      compatibleConfigs: [read.snapshot.config, read.snapshot.runtimeConfig],
      env: process.env,
      workspaceDir: pluginMetadataSnapshot.workspaceDir,
    });
  }
  return { ...read, pluginMetadataSnapshot };
}
