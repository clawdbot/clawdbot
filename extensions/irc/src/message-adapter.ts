import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-message";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig } from "./types.js";

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
      await sendMessageIrc(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      }),
    media: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
      await sendMessageIrc(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      }),
  },
});
