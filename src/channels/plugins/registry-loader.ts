import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry = getActivePluginChannelRegistry();
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    if (!pluginEntry) {
      return undefined;
    }
    return resolveValue(pluginEntry);
  };
}
