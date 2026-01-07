import {
  chunkMarkdownText,
  chunkText,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { sendMessageDiscord } from "../../discord/send.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { sendMessageSignal } from "../../signal/send.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import { sendMessageWhatsApp } from "../../web/outbound.js";
import type { OutboundProvider } from "./targets.js";

const MB = 1024 * 1024;

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

function resolveChunker(provider: OutboundProvider): Chunker | null {
  if (provider === "telegram") return chunkMarkdownText;
  if (provider === "whatsapp") return chunkText;
  if (provider === "signal") return chunkText;
  if (provider === "imessage") return chunkText;
  return null;
}

function resolveSignalMaxBytes(cfg: ClawdbotConfig): number | undefined {
  if (cfg.signal?.mediaMaxMb) return cfg.signal.mediaMaxMb * MB;
  if (cfg.agent?.mediaMaxMb) return cfg.agent.mediaMaxMb * MB;
  return undefined;
}

function resolveIMessageMaxBytes(cfg: ClawdbotConfig): number | undefined {
  if (cfg.imessage?.mediaMaxMb) return cfg.imessage.mediaMaxMb * MB;
  if (cfg.agent?.mediaMaxMb) return cfg.agent.mediaMaxMb * MB;
  return undefined;
}

function normalizeMediaUrls(payload: ReplyPayload): string[] {
  return payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
}

export async function deliverOutboundPayloads(params: {
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  payloads: ReplyPayload[];
  deps?: OutboundSendDeps;
}): Promise<OutboundDeliveryResult[]> {
  const { cfg, provider, to, payloads } = params;
  const deps = {
    sendWhatsApp: params.deps?.sendWhatsApp ?? sendMessageWhatsApp,
    sendTelegram: params.deps?.sendTelegram ?? sendMessageTelegram,
    sendDiscord: params.deps?.sendDiscord ?? sendMessageDiscord,
    sendSlack: params.deps?.sendSlack ?? sendMessageSlack,
    sendSignal: params.deps?.sendSignal ?? sendMessageSignal,
    sendIMessage: params.deps?.sendIMessage ?? sendMessageIMessage,
  };
  const results: OutboundDeliveryResult[] = [];

  const chunker = resolveChunker(provider);
  const textLimit = chunker ? resolveTextChunkLimit(cfg, provider) : undefined;
  const telegramToken =
    provider === "telegram"
      ? resolveTelegramToken(cfg).token || undefined
      : undefined;
  const signalMaxBytes =
    provider === "signal" ? resolveSignalMaxBytes(cfg) : undefined;
  const imessageMaxBytes =
    provider === "imessage" ? resolveIMessageMaxBytes(cfg) : undefined;

  const sendTextChunks = async (text: string) => {
    if (!chunker || textLimit === undefined) {
      await sendText(text);
      return;
    }
    for (const chunk of chunker(text, textLimit)) {
      await sendText(chunk);
    }
  };

  const sendText = async (text: string) => {
    if (provider === "whatsapp") {
      const res = await deps.sendWhatsApp(to, text, { verbose: false });
      results.push({ provider: "whatsapp", ...res });
      return;
    }
    if (provider === "telegram") {
      const res = await deps.sendTelegram(to, text, {
        verbose: false,
        token: telegramToken,
      });
      results.push({ provider: "telegram", ...res });
      return;
    }
    if (provider === "signal") {
      const res = await deps.sendSignal(to, text, { maxBytes: signalMaxBytes });
      results.push({ provider: "signal", ...res });
      return;
    }
    if (provider === "imessage") {
      const res = await deps.sendIMessage(to, text, {
        maxBytes: imessageMaxBytes,
      });
      results.push({ provider: "imessage", ...res });
      return;
    }
    if (provider === "slack") {
      const res = await deps.sendSlack(to, text);
      results.push({ provider: "slack", ...res });
      return;
    }
    const res = await deps.sendDiscord(to, text, { verbose: false });
    results.push({ provider: "discord", ...res });
  };

  const sendMedia = async (caption: string, mediaUrl: string) => {
    if (provider === "whatsapp") {
      const res = await deps.sendWhatsApp(to, caption, {
        verbose: false,
        mediaUrl,
      });
      results.push({ provider: "whatsapp", ...res });
      return;
    }
    if (provider === "telegram") {
      const res = await deps.sendTelegram(to, caption, {
        verbose: false,
        mediaUrl,
        token: telegramToken,
      });
      results.push({ provider: "telegram", ...res });
      return;
    }
    if (provider === "signal") {
      const res = await deps.sendSignal(to, caption, {
        mediaUrl,
        maxBytes: signalMaxBytes,
      });
      results.push({ provider: "signal", ...res });
      return;
    }
    if (provider === "imessage") {
      const res = await deps.sendIMessage(to, caption, {
        mediaUrl,
        maxBytes: imessageMaxBytes,
      });
      results.push({ provider: "imessage", ...res });
      return;
    }
    if (provider === "slack") {
      const res = await deps.sendSlack(to, caption, { mediaUrl });
      results.push({ provider: "slack", ...res });
      return;
    }
    const res = await deps.sendDiscord(to, caption, {
      verbose: false,
      mediaUrl,
    });
    results.push({ provider: "discord", ...res });
  };

  for (const payload of payloads) {
    const text = payload.text ?? "";
    const mediaUrls = normalizeMediaUrls(payload);
    if (!text && mediaUrls.length === 0) continue;

    if (mediaUrls.length === 0) {
      await sendTextChunks(text);
      continue;
    }

    let first = true;
    for (const url of mediaUrls) {
      const caption = first ? text : "";
      first = false;
      await sendMedia(caption, url);
    }
  }
  return results;
}
