import type { ChannelId, ChannelPlugin } from "./types.js";
import type { ChatChannelId } from "../registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";

type PluginLoader = () => Promise<ChannelPlugin>;

// Channel docking: load *one* plugin on-demand.
//
// This avoids importing `src/channels/plugins/index.ts` (intentionally heavy)
// from shared flows like outbound delivery / followup routing.
const LOADERS: Record<ChatChannelId, PluginLoader> = {
  telegram: async () => (await import("./telegram.js")).telegramPlugin,
  whatsapp: async () => (await import("./whatsapp.js")).whatsappPlugin,
  discord: async () => (await import("./discord.js")).discordPlugin,
  slack: async () => (await import("./slack.js")).slackPlugin,
  signal: async () => (await import("./signal.js")).signalPlugin,
  imessage: async () => (await import("./imessage.js")).imessagePlugin,
  msteams: async () => (await import("./msteams.js")).msteamsPlugin,
};

const cache = new Map<ChannelId, ChannelPlugin>();

export async function loadChannelPlugin(id: ChannelId): Promise<ChannelPlugin | undefined> {
  const cached = cache.get(id);
  if (cached) return cached;
  const registry = getActivePluginRegistry();
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  if (pluginEntry) {
    cache.set(id, pluginEntry.plugin);
    return pluginEntry.plugin;
  }
  const loader = LOADERS[id as ChatChannelId];
  if (!loader) return undefined;
  const plugin = await loader();
  cache.set(id, plugin);
  return plugin;
}
