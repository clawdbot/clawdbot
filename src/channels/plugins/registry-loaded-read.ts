/**
 * Hot-path loaded channel plugin reader.
 *
 * Reads active runtime channel state without materializing the full registry view.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ActiveChannelPluginRuntimeShape } from "../../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

function coerceLoadedChannelPlugin(
  plugin: ActiveChannelPluginRuntimeShape | null | undefined,
): ChannelPlugin | undefined {
  const id = normalizeOptionalString(plugin?.id) ?? "";
  if (!plugin || !id) {
    return undefined;
  }
  if (!plugin.meta || typeof plugin.meta !== "object") {
    // Normalize optional metadata for callers that inspect labels/capabilities
    // without requiring a full registry view materialization.
    plugin.meta = {};
  }
  return plugin as ChannelPlugin;
}

/**
 * Reads one loaded channel plugin directly from active runtime state.
 */
export function getLoadedChannelPluginForRead(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  const registry = getActivePluginChannelRegistryFromState();
  if (!registry || !Array.isArray(registry.channels)) {
    return undefined;
  }
  for (const entry of registry.channels) {
    const plugin = coerceLoadedChannelPlugin(entry?.plugin);
    if (plugin && plugin.id === resolvedId) {
      return plugin;
    }
  }
  return undefined;
}
