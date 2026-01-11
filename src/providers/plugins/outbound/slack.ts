import { sendMessageSlack } from "../../../slack/send.js";
import type { ProviderOutboundAdapter } from "../types.js";

export const slackOutbound: ProviderOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Slack requires --to <channelId|user:ID|channel:ID>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ to, text, accountId, deps, replyToId }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    const result = await send(to, text, {
      threadTs: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { provider: "slack", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    const result = await send(to, text, {
      mediaUrl,
      threadTs: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { provider: "slack", ...result };
  },
};
