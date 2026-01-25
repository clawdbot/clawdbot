import { chunkText } from "../../../auto-reply/chunk.js";
import { sendMessageIMessage } from "../../../imessage/send.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const imessageOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const send = deps?.sendIMessage ?? sendMessageIMessage;
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.channels?.imessage?.mediaMaxMb,
      accountId,
    });
    const result = await send(to, text, {
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { channel: "imessage", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
    const send = deps?.sendIMessage ?? sendMessageIMessage;
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.channels?.imessage?.mediaMaxMb,
      accountId,
    });
    const result = await send(to, text, {
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { channel: "imessage", ...result };
  },
};
