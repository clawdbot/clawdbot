// Irc plugin module implements message adapter behavior.
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig } from "./types.js";

async function sendIrcMessage(...args: Parameters<typeof sendMessageIrc>) {
  const { target, ...result } = await sendMessageIrc(...args);
  return {
    ...result,
    target: { kind: "conversation" as const, id: target },
  };
}

export const ircMessageAdapter = defineChannelMessageAdapter({
  id: "irc",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId }) =>
      await sendIrcMessage(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      }),
    media: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
      await sendIrcMessage(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      }),
  },
});
