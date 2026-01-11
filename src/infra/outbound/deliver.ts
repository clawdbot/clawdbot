import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { sendMessageDiscord } from "../../discord/send.js";
import type { sendMessageIMessage } from "../../imessage/send.js";
import { loadProviderOutboundAdapter } from "../../providers/plugins/outbound/load.js";
import type { ProviderOutboundAdapter } from "../../providers/plugins/types.js";
import type { sendMessageSignal } from "../../signal/send.js";
import type { sendMessageSlack } from "../../slack/send.js";
import type { sendMessageTelegram } from "../../telegram/send.js";
import type { sendMessageWhatsApp } from "../../web/outbound.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import { normalizeOutboundPayloads } from "./payloads.js";
import type { OutboundProvider } from "./targets.js";

export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";

export type OutboundSendDeps = {
  sendWhatsApp?: typeof sendMessageWhatsApp;
  sendTelegram?: typeof sendMessageTelegram;
  sendDiscord?: typeof sendMessageDiscord;
  sendSlack?: typeof sendMessageSlack;
  sendSignal?: typeof sendMessageSignal;
  sendIMessage?: typeof sendMessageIMessage;
  sendMSTeams?: (
    to: string,
    text: string,
    opts?: { mediaUrl?: string },
  ) => Promise<{ messageId: string; conversationId: string }>;
};

export type OutboundDeliveryResult = {
  provider: Exclude<OutboundProvider, "none">;
  messageId: string;
  chatId?: string;
  channelId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  // Provider docking: stash provider-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
};

type Chunker = (text: string, limit: number) => string[];

type ProviderHandler = {
  chunker: Chunker | null;
  textChunkLimit?: number;
  sendText: (text: string) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
  ) => Promise<OutboundDeliveryResult>;
};

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new Error("Outbound delivery aborted");
  }
}

// Provider docking: outbound delivery delegates to plugin.outbound adapters.
async function createProviderHandler(params: {
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: number | null;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
}): Promise<ProviderHandler> {
  const outbound = await loadProviderOutboundAdapter(params.provider);
  if (!outbound?.sendText || !outbound?.sendMedia) {
    throw new Error(`Outbound not configured for provider: ${params.provider}`);
  }
  const handler = createPluginHandler({
    outbound,
    cfg: params.cfg,
    provider: params.provider,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    deps: params.deps,
    gifPlayback: params.gifPlayback,
  });
  if (!handler) {
    throw new Error(`Outbound not configured for provider: ${params.provider}`);
  }
  return handler;
}

function createPluginHandler(params: {
  outbound?: ProviderOutboundAdapter;
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: number | null;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
}): ProviderHandler | null {
  const outbound = params.outbound;
  if (!outbound?.sendText || !outbound?.sendMedia) return null;
  const sendText = outbound.sendText;
  const sendMedia = outbound.sendMedia;
  const chunker = outbound.chunker ?? null;
  return {
    chunker,
    textChunkLimit: outbound.textChunkLimit,
    sendText: async (text) =>
      sendText({
        cfg: params.cfg,
        to: params.to,
        text,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        gifPlayback: params.gifPlayback,
        deps: params.deps,
      }),
    sendMedia: async (caption, mediaUrl) =>
      sendMedia({
        cfg: params.cfg,
        to: params.to,
        text: caption,
        mediaUrl,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        gifPlayback: params.gifPlayback,
        deps: params.deps,
      }),
  };
}

export async function deliverOutboundPayloads(params: {
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: number | null;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
}): Promise<OutboundDeliveryResult[]> {
  const { cfg, provider, to, payloads } = params;
  const accountId = params.accountId;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const results: OutboundDeliveryResult[] = [];
  const handler = await createProviderHandler({
    cfg,
    provider,
    to,
    deps,
    accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
  });
  const textLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, provider, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;

  const sendTextChunks = async (text: string) => {
    throwIfAborted(abortSignal);
    if (!handler.chunker || textLimit === undefined) {
      results.push(await handler.sendText(text));
      return;
    }
    for (const chunk of handler.chunker(text, textLimit)) {
      throwIfAborted(abortSignal);
      results.push(await handler.sendText(chunk));
    }
  };

  const normalizedPayloads = normalizeOutboundPayloads(payloads);
  for (const payload of normalizedPayloads) {
    try {
      throwIfAborted(abortSignal);
      params.onPayload?.(payload);
      if (payload.mediaUrls.length === 0) {
        await sendTextChunks(payload.text);
        continue;
      }

      let first = true;
      for (const url of payload.mediaUrls) {
        throwIfAborted(abortSignal);
        const caption = first ? payload.text : "";
        first = false;
        results.push(await handler.sendMedia(caption, url));
      }
    } catch (err) {
      if (!params.bestEffort) throw err;
      params.onError?.(err, payload);
    }
  }
  return results;
}
