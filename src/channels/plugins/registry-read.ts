import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getBundledChannelPlugin } from "./bundled.js";
import { getLoadedChannelPluginById, listLoadedChannelPlugins } from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export function listChannelPluginsForRead(): ChannelPlugin[] {
  return listLoadedChannelPlugins() as ChannelPlugin[];
}

export function getLoadedChannelPluginForRead(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPluginById(resolvedId) as ChannelPlugin | undefined;
}

export function getChannelPluginForRead(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPluginForRead(resolvedId) ?? getBundledChannelPlugin(resolvedId);
}
