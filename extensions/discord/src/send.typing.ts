import { resolveDiscordRest } from "./client.js";
import { sendChannelTyping } from "./internal/discord.js";
import type { DiscordReactOpts } from "./send.types.js";

export async function sendTypingDiscord(channelId: string, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await sendChannelTyping(rest, channelId);
  return { ok: true, channelId };
}
