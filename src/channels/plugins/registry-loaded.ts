/**
 * Loaded channel plugin registry view.
 *
 * Normalizes and sorts active plugin runtime state for channel registry callers.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistration,
} from "../../plugins/channel-registry-state.types.js";
import {
  getActivePluginChannelRegistrySnapshotFromState,
  type ActivePluginChannelRegistrySnapshot,
} from "../../plugins/runtime-channel-state.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

/**
 * Loaded channel plugin shape after id/meta normalization.
 */
type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
  id: string;
  meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};

/**
 * Loaded channel registry entry with a normalized plugin payload.
 */
type LoadedChannelPluginEntry = ActivePluginChannelRegistration & {
  plugin: LoadedChannelPlugin;
};

type ChannelPluginView = {
  snapshot: ActivePluginChannelRegistrySnapshot;
  sorted: LoadedChannelPlugin[];
  byId: Map<string, LoadedChannelPlugin>;
  entriesById: Map<string, LoadedChannelPluginEntry>;
};

let cachedChannelPluginView: ChannelPluginView | undefined;

function coerceLoadedChannelPlugin(
  plugin: ActiveChannelPluginRuntimeShape | null | undefined,
): LoadedChannelPlugin | null {
  const id = normalizeOptionalString(plugin?.id) ?? "";
  if (!plugin || !id) {
    return null;
  }
  if (!plugin.meta || typeof plugin.meta !== "object") {
    // Loaded plugin metadata is optional at the runtime-state boundary, but
    // channel sorting expects an object so normalize it once at read time.
    plugin.meta = {};
  }
  return plugin as LoadedChannelPlugin;
}

function dedupeChannels(channels: LoadedChannelPlugin[]): LoadedChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: LoadedChannelPlugin[] = [];
  for (const plugin of channels) {
    const id = normalizeOptionalString(plugin.id) ?? "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    resolved.push(plugin);
  }
  return resolved;
}

function resolveChannelPlugins(): ChannelPluginView {
  const snapshot = getActivePluginChannelRegistrySnapshotFromState();
  const cached = cachedChannelPluginView;
  if (cached?.snapshot === snapshot) {
    return cached;
  }
  const registry = snapshot.registry;

  const channelPlugins: LoadedChannelPlugin[] = [];
  const pluginEntries: LoadedChannelPluginEntry[] = [];
  if (registry && Array.isArray(registry.channels)) {
    for (const entry of registry.channels) {
      const plugin = coerceLoadedChannelPlugin(entry?.plugin);
      if (plugin) {
        channelPlugins.push(plugin);
        pluginEntries.push({ ...entry, plugin });
      }
    }
  }

  const sorted = dedupeChannels(channelPlugins).toSorted((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
    // Explicit plugin order wins; known built-ins keep their product order;
    // unknown extension channels sort after them by id for deterministic lists.
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
  const byId = new Map<string, LoadedChannelPlugin>();
  const entriesById = new Map<string, LoadedChannelPluginEntry>();
  const unsortedEntriesById = new Map(pluginEntries.map((entry) => [entry.plugin.id, entry]));
  for (const plugin of sorted) {
    byId.set(plugin.id, plugin);
    const entry = unsortedEntriesById.get(plugin.id);
    if (entry) {
      entriesById.set(plugin.id, entry);
    }
  }

  // The runtime owns snapshot invalidation across active and pinned registry
  // changes. Share one derived view until that lifecycle snapshot changes.
  cachedChannelPluginView = {
    snapshot,
    sorted,
    byId,
    entriesById,
  };
  return cachedChannelPluginView;
}

/**
 * Lists loaded channel plugins in deterministic display/runtime order.
 */
export function listLoadedChannelPlugins(): LoadedChannelPlugin[] {
  return resolveChannelPlugins().sorted.slice();
}

/**
 * Returns a loaded channel plugin by normalized id.
 */
export function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().byId.get(resolvedId);
}

/** Returns one loaded channel plugin without triggering bundled discovery. */
export function getLoadedChannelPluginForRead(id: ChannelId): ChannelPlugin | undefined {
  return getLoadedChannelPluginById(id) as ChannelPlugin | undefined;
}

/**
 * Returns the loaded channel registry entry by normalized plugin id.
 */
export function getLoadedChannelPluginEntryById(id: string): LoadedChannelPluginEntry | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().entriesById.get(resolvedId);
}
