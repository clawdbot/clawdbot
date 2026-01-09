import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { sendMessageDiscord } from "../../discord/send.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { sendMessageMSTeams } from "../../msteams/send.js";
import { getProviderPlugin } from "../../providers/plugins/index.js";
import type { ProviderOutboundAdapter } from "../../providers/plugins/types.js";
import { sendMessageSignal } from "../../signal/send.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { sendMessageWhatsApp } from "../../web/outbound.js";
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

export type OutboundDeliveryResult =
  | { provider: "whatsapp"; messageId: string; toJid: string }
  | { provider: "telegram"; messageId: string; chatId: string }
  | { provider: "discord"; messageId: string; channelId: string }
  | { provider: "slack"; messageId: string; channelId: string }
  | { provider: "signal"; messageId: string; timestamp?: number }
  | { provider: "imessage"; messageId: string }
  | { provider: "msteams"; messageId: string; conversationId: string };

type Chunker = (text: string, limit: number) => string[];

type ProviderHandler = {
  chunker: Chunker | null;
  sendText: (text: string) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
  ) => Promise<OutboundDeliveryResult>;
};

function createProviderHandler(params: {
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  accountId?: string;
  deps: Required<OutboundSendDeps>;
  gifPlayback?: boolean;
}): ProviderHandler {
  const plugin = getProviderPlugin(params.provider);
  if (!plugin?.outbound?.sendText || !plugin?.outbound?.sendMedia) {
    throw new Error(`Outbound not configured for provider: ${params.provider}`);
  }
  const handler = createPluginHandler({
    outbound: plugin.outbound,
    cfg: params.cfg,
    provider: params.provider,
    to: params.to,
    accountId: params.accountId,
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
  deps: Required<OutboundSendDeps>;
  gifPlayback?: boolean;
}): ProviderHandler | null {
  const outbound = params.outbound;
  if (!outbound?.sendText || !outbound?.sendMedia) return null;
  const sendText = outbound.sendText;
  const sendMedia = outbound.sendMedia;
  const chunker = outbound.chunker ?? null;
  return {
    chunker,
    sendText: async (text) =>
      sendText({
        cfg: params.cfg,
        to: params.to,
        text,
        accountId: params.accountId,
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
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
}): Promise<OutboundDeliveryResult[]> {
  const { cfg, provider, to, payloads } = params;
  const accountId = params.accountId;
  const defaultSendMSTeams = async (
    to: string,
    text: string,
    opts?: { mediaUrl?: string },
  ) => sendMessageMSTeams({ cfg, to, text, mediaUrl: opts?.mediaUrl });
  const deps = {
    sendWhatsApp: params.deps?.sendWhatsApp ?? sendMessageWhatsApp,
    sendTelegram: params.deps?.sendTelegram ?? sendMessageTelegram,
    sendDiscord: params.deps?.sendDiscord ?? sendMessageDiscord,
    sendSlack: params.deps?.sendSlack ?? sendMessageSlack,
    sendSignal: params.deps?.sendSignal ?? sendMessageSignal,
    sendIMessage: params.deps?.sendIMessage ?? sendMessageIMessage,
    sendMSTeams: params.deps?.sendMSTeams ?? defaultSendMSTeams,
  };
  const results: OutboundDeliveryResult[] = [];
  const handler = createProviderHandler({
    cfg,
    provider,
    to,
    deps,
    accountId,
    gifPlayback: params.gifPlayback,
  });
  const textLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, provider, accountId)
    : undefined;

  const sendTextChunks = async (text: string) => {
    if (!handler.chunker || textLimit === undefined) {
      results.push(await handler.sendText(text));
      return;
    }
    for (const chunk of handler.chunker(text, textLimit)) {
      results.push(await handler.sendText(chunk));
    }
  };

  const normalizedPayloads = normalizeOutboundPayloads(payloads);
  for (const payload of normalizedPayloads) {
    try {
      params.onPayload?.(payload);
      if (payload.mediaUrls.length === 0) {
        await sendTextChunks(payload.text);
        continue;
      }

      let first = true;
      for (const url of payload.mediaUrls) {
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
