import type { ChannelId, ChannelOutboundAdapter } from "../types.js";

type OutboundLoader = () => Promise<ChannelOutboundAdapter>;

// Channel docking: outbound sends should stay cheap to import.
//
// The full channel plugins (src/channels/plugins/*.ts) pull in status,
// onboarding, gateway monitors, etc. Outbound delivery only needs chunking +
// send primitives, so we keep a dedicated, lightweight loader here.
const LOADERS: Record<ChannelId, OutboundLoader> = {
  telegram: async () => (await import("./telegram.js")).telegramOutbound,
  whatsapp: async () => (await import("./whatsapp.js")).whatsappOutbound,
  discord: async () => (await import("./discord.js")).discordOutbound,
  slack: async () => (await import("./slack.js")).slackOutbound,
  signal: async () => (await import("./signal.js")).signalOutbound,
  imessage: async () => (await import("./imessage.js")).imessageOutbound,
  msteams: async () => (await import("./msteams.js")).msteamsOutbound,
};

const cache = new Map<ChannelId, ChannelOutboundAdapter>();

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  const cached = cache.get(id);
  if (cached) return cached;
  const loader = LOADERS[id];
  if (!loader) return undefined;
  const outbound = await loader();
  cache.set(id, outbound);
  return outbound;
}
