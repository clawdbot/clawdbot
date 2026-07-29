/**
 * Lazy channel registry value loader.
 *
 * Resolves plugin sub-surfaces from active channel or full plugin registry state.
 */
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

/**
 * Creates a lazy loader that resolves one value from the active channel registry.
 */
export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const resolveFromRegistry = (
      registry: ReturnType<typeof getActivePluginRegistry>,
    ): TValue | undefined => {
      const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
      return pluginEntry ? resolveValue(pluginEntry) : undefined;
    };

    const channelRegistry = getActivePluginChannelRegistry();
    const channelValue = resolveFromRegistry(channelRegistry);
    if (channelValue !== undefined) {
      return channelValue;
    }

    const activeRegistry = getActivePluginRegistry();
    if (activeRegistry && activeRegistry !== channelRegistry) {
      // During startup some callers see a narrower channel registry first.
      // Fall back to the full active registry when it is a distinct object.
      return resolveFromRegistry(activeRegistry);
    }

    return undefined;
  };
}
