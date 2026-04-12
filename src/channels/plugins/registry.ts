import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getBundledChannelPlugin } from "./bundled.js";
import { getLoadedChannelPluginById, listLoadedChannelPlugins } from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export function listChannelPlugins(): ChannelPlugin[] {
  return listLoadedChannelPlugins() as ChannelPlugin[];
}

export function getLoadedChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPluginById(resolvedId) as ChannelPlugin | undefined;
}

export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPlugin(resolvedId) ?? getBundledChannelPlugin(resolvedId);
}

export function normalizeChannelId(raw?: string | null): ChannelId | null {
  return normalizeAnyChannelId(raw);
}
