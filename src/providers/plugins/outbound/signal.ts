import { chunkText } from "../../../auto-reply/chunk.js";
import { sendMessageSignal } from "../../../signal/send.js";
import { resolveProviderMediaMaxBytes } from "../media-limits.js";
import type { ProviderOutboundAdapter } from "../types.js";

export const signalOutbound: ProviderOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Signal requires --to <E.164|group:ID|signal:group:ID|signal:+E.164>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const send = deps?.sendSignal ?? sendMessageSignal;
    const maxBytes = resolveProviderMediaMaxBytes({
      cfg,
      resolveProviderLimitMb: ({ cfg, accountId }) =>
        cfg.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.signal?.mediaMaxMb,
      accountId,
    });
    const result = await send(to, text, {
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { provider: "signal", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
    const send = deps?.sendSignal ?? sendMessageSignal;
    const maxBytes = resolveProviderMediaMaxBytes({
      cfg,
      resolveProviderLimitMb: ({ cfg, accountId }) =>
        cfg.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.signal?.mediaMaxMb,
      accountId,
    });
    const result = await send(to, text, {
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { provider: "signal", ...result };
  },
};
