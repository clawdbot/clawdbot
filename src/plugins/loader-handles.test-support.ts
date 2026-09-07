/** Loader tests own returned executable registries until their test host finishes. */
import { afterEach } from "vitest";
import * as loader from "./loader.js";
import {
  drainPluginRegistryResourceDisposals,
  type PluginRegistryHandle,
} from "./registry-resources.js";

const handles = new Set<PluginRegistryHandle>();
function retain(handle: PluginRegistryHandle) {
  handles.add(handle);
  return handle.registry;
}
export { retain as retainPluginRegistryHandleForTest };

afterEach(async () => {
  for (const handle of handles) {
    handle.release();
  }
  handles.clear();
  await drainPluginRegistryResourceDisposals();
});

export const loadOpenClawPluginsForTest = (
  ...args: Parameters<typeof loader.loadOpenClawPlugins>
) => retain(loader.loadOpenClawPlugins(...args));
export const loadPluginRegistryHandleForTest = (
  ...args: Parameters<typeof loader.loadPluginRegistryHandle>
) => retain(loader.loadPluginRegistryHandle(...args));
export const loadOpenClawPluginCliRegistryForTest = async (
  ...args: Parameters<typeof loader.loadOpenClawPluginCliRegistry>
) => retain(await loader.loadOpenClawPluginCliRegistry(...args));
export const resolveRuntimePluginRegistryForTest = (
  ...args: Parameters<typeof loader.resolveRuntimePluginRegistry>
) => {
  const handle = loader.resolveRuntimePluginRegistry(...args);
  return handle && retain(handle);
};
export { clearPluginRegistryLoadCache, loadAndActivateRootPluginRegistry } from "./loader.js";
export type { PluginLoadOptions } from "./loader.js";
