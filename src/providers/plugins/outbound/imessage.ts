import { chunkText } from "../../../auto-reply/chunk.js";
import { sendMessageIMessage } from "../../../imessage/send.js";
import { resolveProviderMediaMaxBytes } from "../media-limits.js";
import type { ProviderOutboundAdapter } from "../types.js";

export const imessageOutbound: ProviderOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to iMessage requires --to <handle|chat_id:ID>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const send = deps?.sendIMessage ?? sendMessageIMessage;
    const maxBytes = resolveProviderMediaMaxBytes({
      cfg,
      resolveProviderLimitMb: ({ cfg, accountId }) =>
        cfg.imessage?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.imessage?.mediaMaxMb,
      accountId,
    });
    const result = await send(to, text, {
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { provider: "imessage", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
    const send = deps?.sendIMessage ?? sendMessageIMessage;
    const maxBytes = resolveProviderMediaMaxBytes({
      cfg,
      resolveProviderLimitMb: ({ cfg, accountId }) =>
        cfg.imessage?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.imessage?.mediaMaxMb,
      accountId,
    });
    const result = await send(to, text, {
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { provider: "imessage", ...result };
  },
};
