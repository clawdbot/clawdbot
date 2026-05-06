import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-message";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkMessageAdapter = defineChannelMessageAdapter({
  id: "nextcloud-talk",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId }) =>
      await sendMessageNextcloudTalk(to, text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        cfg: cfg as CoreConfig,
      }),
    media: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
      await sendMessageNextcloudTalk(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        cfg: cfg as CoreConfig,
      }),
  },
});
