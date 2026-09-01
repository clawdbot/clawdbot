/** Active channel plugin registry with bundled fallback. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getBundledChannelPlugin } from "./bundled.js";
import {
  getLoadedChannelPluginById,
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export const listChannelPlugins = () => listLoadedChannelPlugins() as ChannelPlugin[];

/**
 * Returns a loaded channel plugin without falling back to bundled metadata.
 */
export function getLoadedChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return getLoadedChannelPluginById(id) as ChannelPlugin | undefined;
}

/**
 * Returns the package/install origin for a loaded channel plugin.
 */
export function getLoadedChannelPluginOrigin(id: ChannelId): string | undefined {
  return normalizeOptionalString(getLoadedChannelPluginEntryById(id)?.origin);
}

/**
 * Resolves the active channel implementation together with host-owned provenance.
 */
export function resolveChannelPluginRegistration(id: ChannelId):
  | {
      plugin: ChannelPlugin;
      origin?: string;
      resolveChannelRuntime?: NonNullable<
        ReturnType<typeof getLoadedChannelPluginEntryById>
      >["resolveChannelRuntime"];
    }
  | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  // Resolve implementation and provenance together. Loaded overrides win and
  // must never borrow bundled authority from the fallback with the same id.
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const loadedEntry =
    (scopedRegistry ? getLoadedChannelPluginEntryById(resolvedId, scopedRegistry) : undefined) ??
    getLoadedChannelPluginEntryById(resolvedId);
  if (loadedEntry) {
    const origin = normalizeOptionalString(loadedEntry.origin) ?? undefined;
    return {
      plugin: loadedEntry.plugin as ChannelPlugin,
      ...(loadedEntry.resolveChannelRuntime
        ? { resolveChannelRuntime: loadedEntry.resolveChannelRuntime }
        : {}),
      ...(origin ? { origin } : {}),
    };
  }
  const plugin = getBundledChannelPlugin(resolvedId);
  return plugin ? { plugin, origin: "bundled" } : undefined;
}

/**
 * Returns the active channel plugin, with bundled fallback for built-in channels.
 */
export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return resolveChannelPluginRegistration(id)?.plugin;
}

/**
 * Normalizes user-facing channel aliases to canonical channel ids.
 */
export function normalizeChannelId(raw?: string | null): ChannelId | null {
  return normalizeAnyChannelId(raw);
}
