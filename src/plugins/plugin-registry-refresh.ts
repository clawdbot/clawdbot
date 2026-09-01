/** Refreshes the persisted plugin registry for mutation and doctor flows. */
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store.js";
import type { RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
import {
  resolveControlPlaneRegistryParams,
  type PluginRegistrySnapshot,
} from "./plugin-registry-snapshot.js";

export function refreshPluginRegistry(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<PluginRegistrySnapshot> {
  if (!params.config) {
    return refreshPersistedInstalledPluginIndex(params);
  }
  return refreshPersistedInstalledPluginIndex(resolveControlPlaneRegistryParams(params));
}
