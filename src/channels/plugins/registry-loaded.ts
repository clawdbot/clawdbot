import type { ActiveChannelPluginRuntimeShape } from "../../plugins/channel-registry-state.types.js";
import {
  getActivePluginChannelRegistryFromState,
  getActivePluginChannelRegistryVersionFromState,
} from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";

export type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
  id: string;
  meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};

type CachedChannelPlugins = {
  registryVersion: number;
  registryRef: object | null;
  sorted: LoadedChannelPlugin[];
  byId: Map<string, LoadedChannelPlugin>;
};

const EMPTY_CHANNEL_PLUGIN_CACHE: CachedChannelPlugins = {
  registryVersion: -1,
  registryRef: null,
  sorted: [],
  byId: new Map(),
};

let cachedChannelPlugins = EMPTY_CHANNEL_PLUGIN_CACHE;

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

function resolveCachedChannelPlugins(): CachedChannelPlugins {
  const registry = getActivePluginChannelRegistryFromState();
  const registryVersion = getActivePluginChannelRegistryVersionFromState();
  const cached = cachedChannelPlugins;
  if (cached.registryVersion === registryVersion && cached.registryRef === registry) {
    return cached;
  }

  const channelPlugins: LoadedChannelPlugin[] = [];
  if (registry && Array.isArray(registry.channels)) {
    for (const entry of registry.channels) {
      const plugin = coerceLoadedChannelPlugin(entry?.plugin);
      if (plugin) {
        channelPlugins.push(plugin);
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
  for (const plugin of sorted) {
    byId.set(plugin.id, plugin);
  }

  const next: CachedChannelPlugins = {
    registryVersion,
    registryRef: registry,
    sorted,
    byId,
  };
  cachedChannelPlugins = next;
  return next;
}

export function listLoadedChannelPlugins(): LoadedChannelPlugin[] {
  return resolveCachedChannelPlugins().sorted.slice();
}

export function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveCachedChannelPlugins().byId.get(resolvedId);
}
