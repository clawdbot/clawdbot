/**
 * Lazy channel registry value loader.
 *
 * Resolves plugin sub-surfaces from the process-root registry.
 */
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
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

    return resolveFromRegistry(
      getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry(),
    );
  };
}
