// Channel plugin reads that include registry handles carried in the runtime
// scope. Kept import-light so leaf modules (target prefixes, selection) can use
// them without pulling the plugin bootstrap/loader graph into their consumers.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  getChannelPlugin,
  getLoadedChannelPlugin,
  listChannelPlugins,
} from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";

/** Finds a channel plugin in a registry by id or channel alias. */
export function findChannelPluginInRegistry(
  registry: PluginRegistry | null | undefined,
  channel: string,
): ChannelPlugin | undefined {
  if (!registry) {
    return undefined;
  }
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!normalizedChannel) {
    return undefined;
  }
  for (const entry of registry.channels) {
    const plugin = entry?.plugin;
    if (
      normalizeOptionalLowercaseString(plugin?.id) === normalizedChannel ||
      plugin?.meta?.aliases?.some(
        (alias) => normalizeOptionalLowercaseString(alias) === normalizedChannel,
      )
    ) {
      return plugin;
    }
  }
  return undefined;
}

// Message CLI actions run against a scoped registry handle without process-root
// activation, so bare getChannelPlugin cannot see installed channel plugins there.
/** Resolves a channel plugin visible to this process, including registry handles in scope. */
export function getRuntimeVisibleChannelPlugin(channel: ChannelId): ChannelPlugin | undefined {
  return (
    findChannelPluginInRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry, channel) ??
    getLoadedChannelPlugin(channel) ??
    getChannelPlugin(channel)
  );
}

/** Lists channel plugins visible to this process, including registry handles in scope. */
export function listRuntimeVisibleChannelPlugins(): ChannelPlugin[] {
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const plugins = listChannelPlugins();
  if (!scopedRegistry) {
    return plugins;
  }
  // The request handle is the active operation-local view. Replace same-id
  // process-root entries while retaining unrelated root channels.
  const scopedPluginIds = new Set<string>();
  const scopedPlugins: ChannelPlugin[] = [];
  for (const entry of scopedRegistry.channels) {
    const plugin = entry?.plugin;
    if (!plugin?.id || scopedPluginIds.has(plugin.id)) {
      continue;
    }
    scopedPluginIds.add(plugin.id);
    scopedPlugins.push(plugin);
  }
  return [...plugins.filter((plugin) => !scopedPluginIds.has(plugin.id)), ...scopedPlugins];
}
