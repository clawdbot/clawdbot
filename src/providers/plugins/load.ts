import type { ProviderId, ProviderPlugin } from "./types.js";

type PluginLoader = () => Promise<ProviderPlugin>;

// Provider docking: load *one* plugin on-demand.
//
// This avoids importing `src/providers/plugins/index.ts` (intentionally heavy)
// from shared flows like outbound delivery / followup routing.
const LOADERS: Record<ProviderId, PluginLoader> = {
  telegram: async () => (await import("./telegram.js")).telegramPlugin,
  whatsapp: async () => (await import("./whatsapp.js")).whatsappPlugin,
  discord: async () => (await import("./discord.js")).discordPlugin,
  slack: async () => (await import("./slack.js")).slackPlugin,
  signal: async () => (await import("./signal.js")).signalPlugin,
  imessage: async () => (await import("./imessage.js")).imessagePlugin,
  msteams: async () => (await import("./msteams.js")).msteamsPlugin,
};

const cache = new Map<ProviderId, ProviderPlugin>();

export async function loadProviderPlugin(
  id: ProviderId,
): Promise<ProviderPlugin | undefined> {
  const cached = cache.get(id);
  if (cached) return cached;
  const loader = LOADERS[id];
  if (!loader) return undefined;
  const plugin = await loader();
  cache.set(id, plugin);
  return plugin;
}
