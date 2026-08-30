import {
  type ConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/config.js";
import {
  createPluginMetadataOwner,
  withPluginMetadataCollectionScope,
} from "../plugins/plugin-metadata-collection.js";

/** Keeps one command's metadata alive through its asynchronous consumers without publishing it. */
export async function withCommandConfigSnapshot<T>(
  options: { observe?: boolean; skipPluginValidation?: boolean },
  run: (snapshot: ConfigFileSnapshot) => T | Promise<T>,
): Promise<T> {
  const pluginMetadataOwner = createPluginMetadataOwner();
  try {
    const { snapshot, pluginMetadata } = await readConfigFileSnapshotWithPluginMetadata({
      ...options,
      pluginMetadataOwner,
    });
    return await (pluginMetadata
      ? withPluginMetadataCollectionScope(pluginMetadata, () => run(snapshot), {
          config: snapshot.sourceConfig,
          compatibleConfigs: [snapshot.config, snapshot.runtimeConfig],
          env: process.env,
        })
      : run(snapshot));
  } finally {
    pluginMetadataOwner.dispose();
  }
}
