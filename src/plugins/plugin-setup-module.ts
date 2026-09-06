import type { PluginManifestRecord } from "./manifest-registry.js";
import { getPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  bindPluginInstanceModuleLoader,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";

/** Setup callbacks and their source graph belong to the inventory that loaded them. */
export function getPluginSetupModuleLoader(
  record: PluginManifestRecord,
  source: string,
  rootDir: string,
  loadHostModule?: (source: string) => unknown,
) {
  const cache = getPluginCache();
  const key = `setup:${record.id}:${source}`;
  const cached = cache.setupModules.get(key);
  if (cached) {
    return (entry: string) => cached.loadModule(entry);
  }
  if (cache.retirement) {
    throw new Error(`Plugin ${record.id} setup inventory has retired`);
  }
  const instance = new PluginInstance(record.id);
  cache.setupModules.set(key, instance);
  bindPluginInstanceModuleLoader({
    instance,
    source,
    rootDir,
    origin: record.origin,
    loadHostModule:
      loadHostModule ??
      getCachedPluginModuleLoader({
        modulePath: source,
        importerUrl: import.meta.url,
      }),
  });
  return (entry: string) => instance.loadModule(entry);
}
