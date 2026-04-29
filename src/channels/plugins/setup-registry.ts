import {
  getActivePluginChannelRegistry,
  requireActivePluginRegistry,
} from "../../plugins/runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "../registry.js";
import { listBundledChannelSetupPlugins } from "./bundled.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type ChannelSetupPluginView = {
  sorted: ChannelPlugin[];
  byId: Map<string, ChannelPlugin>;
};

function dedupeSetupPlugins(plugins: readonly ChannelPlugin[]): ChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: ChannelPlugin[] = [];
  for (const plugin of plugins) {
    const id = normalizeOptionalString(plugin.id) ?? "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    resolved.push(plugin);
  }
  return resolved;
}

function sortChannelSetupPlugins(plugins: readonly ChannelPlugin[]): ChannelPlugin[] {
  return dedupeSetupPlugins(plugins).toSorted((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id as ChatChannelId);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id as ChatChannelId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
}

function resolveChannelSetupPlugins(): ChannelSetupPluginView {
  const registry = requireActivePluginRegistry();

  const registryPlugins = (registry.channelSetups ?? []).map((entry) => entry.plugin);
  const sorted = sortChannelSetupPlugins(
    registryPlugins.length > 0 ? registryPlugins : listBundledChannelSetupPlugins(),
  );
  const byId = new Map<string, ChannelPlugin>();
  for (const plugin of sorted) {
    byId.set(plugin.id, plugin);
  }

  return {
    sorted,
    byId,
  };
}

export function listChannelSetupPlugins(): ChannelPlugin[] {
  return resolveChannelSetupPlugins().sorted.slice();
}

export function listActiveChannelSetupPlugins(): ChannelPlugin[] {
  const registry = getActivePluginChannelRegistry();
  return sortChannelSetupPlugins((registry?.channelSetups ?? []).map((entry) => entry.plugin));
}

export function getChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelSetupPlugins().byId.get(resolvedId);
}
