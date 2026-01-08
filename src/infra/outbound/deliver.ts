import {
  chunkMarkdownText,
  chunkText,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { sendMessageDiscord } from "../../discord/send.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { sendMessageSignal } from "../../signal/send.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { sendMessageWhatsApp } from "../../web/outbound.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import { normalizeOutboundPayloads } from "./payloads.js";
import type { OutboundProvider } from "./targets.js";

const MB = 1024 * 1024;

export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";

export type OutboundSendDeps = {
  sendWhatsApp?: typeof sendMessageWhatsApp;
  sendTelegram?: typeof sendMessageTelegram;
  sendDiscord?: typeof sendMessageDiscord;
  sendSlack?: typeof sendMessageSlack;
  sendSignal?: typeof sendMessageSignal;
  sendIMessage?: typeof sendMessageIMessage;
};

export type OutboundDeliveryResult =
  | { provider: "whatsapp"; messageId: string; toJid: string }
  | { provider: "telegram"; messageId: string; chatId: string }
  | { provider: "discord"; messageId: string; channelId: string }
  | { provider: "slack"; messageId: string; channelId: string }
  | { provider: "signal"; messageId: string; timestamp?: number }
  | { provider: "imessage"; messageId: string };

type Chunker = (text: string, limit: number) => string[];

const providerCaps: Record<
  Exclude<OutboundProvider, "none">,
  { chunker: Chunker | null }
> = {
  whatsapp: { chunker: chunkText },
  telegram: { chunker: chunkMarkdownText },
  discord: { chunker: null },
  slack: { chunker: null },
  signal: { chunker: chunkText },
  imessage: { chunker: chunkText },
};

type ProviderHandler = {
  chunker: Chunker | null;
  sendText: (text: string) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
  ) => Promise<OutboundDeliveryResult>;
};

function resolveMediaMaxBytes(
  cfg: ClawdbotConfig,
  provider: "signal" | "imessage",
  accountId?: string | null,
): number | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const providerLimit =
    provider === "signal"
      ? (cfg.signal?.accounts?.[normalizedAccountId]?.mediaMaxMb ??
        cfg.signal?.mediaMaxMb)
      : (cfg.imessage?.accounts?.[normalizedAccountId]?.mediaMaxMb ??
        cfg.imessage?.mediaMaxMb);
  if (providerLimit) return providerLimit * MB;
  if (cfg.agent?.mediaMaxMb) return cfg.agent.mediaMaxMb * MB;
  return undefined;
}

function createProviderHandler(params: {
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  accountId?: string;
  deps: Required<OutboundSendDeps>;
}): ProviderHandler {
  const { cfg, to, deps } = params;
  const rawAccountId = params.accountId;
  const accountId = normalizeAccountId(rawAccountId);
  const signalMaxBytes =
    params.provider === "signal"
      ? resolveMediaMaxBytes(cfg, "signal", accountId)
      : undefined;
  const imessageMaxBytes =
    params.provider === "imessage"
      ? resolveMediaMaxBytes(cfg, "imessage", accountId)
      : undefined;

  const handlers: Record<Exclude<OutboundProvider, "none">, ProviderHandler> = {
    whatsapp: {
      chunker: providerCaps.whatsapp.chunker,
      sendText: async (text) => ({
        provider: "whatsapp",
        ...(await deps.sendWhatsApp(to, text, {
          verbose: false,
          accountId: rawAccountId,
        })),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "whatsapp",
        ...(await deps.sendWhatsApp(to, caption, {
          verbose: false,
          mediaUrl,
          accountId: rawAccountId,
        })),
      }),
    },
    telegram: {
      chunker: providerCaps.telegram.chunker,
      sendText: async (text) => ({
        provider: "telegram",
        ...(await deps.sendTelegram(to, text, {
          verbose: false,
          accountId: rawAccountId,
        })),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "telegram",
        ...(await deps.sendTelegram(to, caption, {
          verbose: false,
          mediaUrl,
          accountId: rawAccountId,
        })),
      }),
    },
    discord: {
      chunker: providerCaps.discord.chunker,
      sendText: async (text) => ({
        provider: "discord",
        ...(await deps.sendDiscord(to, text, {
          verbose: false,
          accountId: rawAccountId,
        })),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "discord",
        ...(await deps.sendDiscord(to, caption, {
          verbose: false,
          mediaUrl,
          accountId: rawAccountId,
        })),
      }),
    },
    slack: {
      chunker: providerCaps.slack.chunker,
      sendText: async (text) => ({
        provider: "slack",
        ...(await deps.sendSlack(to, text, {
          accountId: rawAccountId,
        })),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "slack",
        ...(await deps.sendSlack(to, caption, {
          mediaUrl,
          accountId: rawAccountId,
        })),
      }),
    },
    signal: {
      chunker: providerCaps.signal.chunker,
      sendText: async (text) => ({
        provider: "signal",
        ...(await deps.sendSignal(to, text, {
          maxBytes: signalMaxBytes,
          accountId: rawAccountId,
        })),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "signal",
        ...(await deps.sendSignal(to, caption, {
          mediaUrl,
          maxBytes: signalMaxBytes,
          accountId: rawAccountId,
        })),
      }),
    },
    imessage: {
      chunker: providerCaps.imessage.chunker,
      sendText: async (text) => ({
        provider: "imessage",
        ...(await deps.sendIMessage(to, text, {
          maxBytes: imessageMaxBytes,
          accountId: rawAccountId,
        })),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "imessage",
        ...(await deps.sendIMessage(to, caption, {
          mediaUrl,
          maxBytes: imessageMaxBytes,
          accountId: rawAccountId,
        })),
      }),
    },
  };

  return handlers[params.provider];
}

export async function deliverOutboundPayloads(params: {
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  deps?: OutboundSendDeps;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
}): Promise<OutboundDeliveryResult[]> {
  const { cfg, provider, to, payloads } = params;
  const accountId = params.accountId;
  const deps = {
    sendWhatsApp: params.deps?.sendWhatsApp ?? sendMessageWhatsApp,
    sendTelegram: params.deps?.sendTelegram ?? sendMessageTelegram,
    sendDiscord: params.deps?.sendDiscord ?? sendMessageDiscord,
    sendSlack: params.deps?.sendSlack ?? sendMessageSlack,
    sendSignal: params.deps?.sendSignal ?? sendMessageSignal,
    sendIMessage: params.deps?.sendIMessage ?? sendMessageIMessage,
  };
  const results: OutboundDeliveryResult[] = [];
  const handler = createProviderHandler({
    cfg,
    provider,
    to,
    deps,
    accountId,
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
