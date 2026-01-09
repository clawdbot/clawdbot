import {
  chunkMarkdownText,
  chunkText,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { sendMessageDiscord } from "../../discord/send.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { sendMessageMSTeams } from "../../msteams/send.js";
import { getProviderPlugin } from "../../providers/plugins/index.js";
import type { ProviderOutboundAdapter } from "../../providers/plugins/types.js";
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
  msteams: { chunker: chunkMarkdownText },
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
  if (cfg.agents?.defaults?.mediaMaxMb) {
    return cfg.agents.defaults.mediaMaxMb * MB;
  }
  return undefined;
}

function createProviderHandler(params: {
  cfg: ClawdbotConfig;
  provider: Exclude<OutboundProvider, "none">;
  to: string;
  accountId?: string;
  deps: Required<OutboundSendDeps>;
  gifPlayback?: boolean;
}): ProviderHandler {
  const rawAccountId = params.accountId;
  const accountId = normalizeAccountId(rawAccountId);
  const signalMaxBytes =
    params.provider === "signal"
      ? resolveMediaMaxBytes(params.cfg, "signal", accountId)
      : undefined;
  const imessageMaxBytes =
    params.provider === "imessage"
      ? resolveMediaMaxBytes(params.cfg, "imessage", accountId)
      : undefined;
  const depsWithLimits: Required<OutboundSendDeps> = {
    ...params.deps,
    sendSignal: signalMaxBytes
      ? (to, text, opts) =>
          params.deps.sendSignal(to, text, {
            ...opts,
            maxBytes: signalMaxBytes,
          })
      : params.deps.sendSignal,
    sendIMessage: imessageMaxBytes
      ? (to, text, opts) =>
          params.deps.sendIMessage(to, text, {
            ...opts,
            maxBytes: imessageMaxBytes,
          })
      : params.deps.sendIMessage,
  };
  const plugin = getProviderPlugin(params.provider);
  const outbound = plugin?.outbound;
  const pluginHandler = createPluginHandler({
    outbound,
    cfg: params.cfg,
    provider: params.provider,
    to: params.to,
    accountId: params.accountId,
    deps: depsWithLimits,
    gifPlayback: params.gifPlayback,
  });
  if (pluginHandler) return pluginHandler;

  const { to } = params;
  const deps = depsWithLimits;

  const handlers: Record<Exclude<OutboundProvider, "none">, ProviderHandler> = {
    whatsapp: {
      chunker: providerCaps.whatsapp.chunker,
      sendText: async (text) => ({
        provider: "whatsapp",
        ...(await deps.sendWhatsApp(to, text, {
          verbose: false,
          accountId: rawAccountId,
          gifPlayback: params.gifPlayback,
        })),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "whatsapp",
        ...(await deps.sendWhatsApp(to, caption, {
          verbose: false,
          mediaUrl,
          accountId: rawAccountId,
          gifPlayback: params.gifPlayback,
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
    msteams: {
      chunker: providerCaps.msteams.chunker,
      sendText: async (text) => ({
        provider: "msteams",
        ...(await deps.sendMSTeams(to, text)),
      }),
      sendMedia: async (caption, mediaUrl) => ({
        provider: "msteams",
        ...(await deps.sendMSTeams(to, caption, { mediaUrl })),
      }),
    },
  };

  return handlers[params.provider];
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
  const chunker =
    outbound.chunker === undefined
      ? providerCaps[params.provider].chunker
      : outbound.chunker;
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
