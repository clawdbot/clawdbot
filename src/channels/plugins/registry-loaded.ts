import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistration,
} from "../../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";

export type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
  id: string;
  meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};

export type LoadedChannelPluginEntry = ActivePluginChannelRegistration & {
  plugin: LoadedChannelPlugin;
};

type ChannelPluginView = {
  sorted: LoadedChannelPlugin[];
  byId: Map<string, LoadedChannelPlugin>;
  entriesById: Map<string, LoadedChannelPluginEntry>;
};

function coerceLoadedChannelPlugin(
  plugin: ActiveChannelPluginRuntimeShape | null | undefined,
): LoadedChannelPlugin | null {
  const id = normalizeOptionalString(plugin?.id) ?? "";
  if (!plugin || !id) {
    return null;
  }
  if (!plugin.meta || typeof plugin.meta !== "object") {
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
  const registry = getActivePluginChannelRegistryFromState();

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

  return {
    sorted,
    byId,
    entriesById,
  };
}

export function listLoadedChannelPlugins(): LoadedChannelPlugin[] {
  return resolveChannelPlugins().sorted.slice();
}

export function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().byId.get(resolvedId);
}

export function getLoadedChannelPluginEntryById(id: string): LoadedChannelPluginEntry | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().entriesById.get(resolvedId);
}
