/**
 * Loaded channel plugin registry view.
 *
 * Normalizes and sorts active plugin runtime state for channel registry callers.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistry,
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
type LoadedChannelPlugin = ChannelPlugin & {
  meta: NonNullable<ChannelPlugin["meta"]>;
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
  return plugin;
}

function resolveChannelPlugins(registry?: ActivePluginChannelRegistry): ChannelPluginView {
  const snapshot = getActivePluginChannelRegistrySnapshotFromState();
  const currentRegistry = registry === undefined || registry === snapshot.registry;
  if (currentRegistry && cachedChannelPluginView?.snapshot === snapshot) {
    return cachedChannelPluginView;
  }
  const selectedRegistry = registry ?? snapshot.registry;

  const seen = new Set<string>();
  const byId = new Map<string, LoadedChannelPlugin>();
  const entriesById = new Map<string, LoadedChannelPluginEntry>();
  if (selectedRegistry && Array.isArray(selectedRegistry.channels)) {
    for (const entry of selectedRegistry.channels) {
      const plugin = coerceLoadedChannelPlugin(entry?.plugin);
      if (!plugin) {
        continue;
      }
      const id = normalizeOptionalString(plugin.id) ?? "";
      if (!id || seen.has(id)) {
        continue;
      }
      // Channel registration is first-wins. Keep its implementation and
      // provenance together so a colliding plugin cannot borrow its authority.
      seen.add(id);
      byId.set(plugin.id, plugin);
      entriesById.set(plugin.id, { ...entry, plugin });
    }
  }

  const sorted = [...byId.values()].toSorted((a, b) => {
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

  const view = {
    snapshot: currentRegistry ? snapshot : { registry: selectedRegistry, version: 0 },
    sorted,
    byId,
    entriesById,
  };
  if (currentRegistry) {
    // Runtime snapshots invalidate the single process-root registry view.
    cachedChannelPluginView = view;
  }
  return view;
}

/**
 * Lists loaded channel plugins in deterministic display/runtime order.
 */
export function listLoadedChannelPlugins(): LoadedChannelPlugin[] {
  return resolveChannelPlugins().sorted.slice();
}

/** Lists one exact registry without substituting a pinned or active registry. */
export function listLoadedChannelPluginsForRegistry(
  registry: ActivePluginChannelRegistry,
): ChannelPlugin[] {
  return resolveChannelPlugins(registry).sorted.slice();
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
  return getLoadedChannelPluginById(id);
}

/**
 * Returns the loaded channel registry entry by normalized plugin id.
 */
export function getLoadedChannelPluginEntryById(
  id: string,
  registry?: ActivePluginChannelRegistry,
): LoadedChannelPluginEntry | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins(registry).entriesById.get(resolvedId);
}
