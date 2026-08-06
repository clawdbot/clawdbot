import { pluginToolDescriptorCacheState } from "./tool-descriptor-cache.js";

export function resetPluginToolDescriptorCacheForTest(): void {
  pluginToolDescriptorCacheState.descriptors.clear();
  pluginToolDescriptorCacheState.objectIds = new WeakMap();
  pluginToolDescriptorCacheState.nextObjectId = 1;
  pluginToolDescriptorCacheState.runtimeRegistries = new WeakMap();
}
