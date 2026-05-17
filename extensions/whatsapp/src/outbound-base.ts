import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  normalizeOptionalAccountId,
  resolveListedDefaultAccountId,
} from "openclaw/plugin-sdk/account-core";
import {
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-send-deps";
import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadText,
} from "./outbound-media-contract.js";
import { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";
import { lookupInboundMessageMetaForTarget } from "./quoted-message.js";
import { toWhatsappJid } from "./text-runtime.js";

type WhatsAppChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;
type WhatsAppSendTextOptions = {
  verbose: boolean;
  cfg: OpenClawConfig;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gifPlayback?: boolean;
  audioAsVoice?: boolean;
  forceDocument?: boolean;
  accountId?: string;
  quotedMessageKey?: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    messageText?: string;
  };
  preserveLeadingWhitespace?: boolean;
};
type WhatsAppSendMessage = (
  to: string,
  body: string,
  options: WhatsAppSendTextOptions,
) => Promise<{ messageId: string; toJid: string }>;
type WhatsAppSendPoll = (
  to: string,
  poll: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0]["poll"],
  options: { verbose: boolean; accountId?: string; cfg: OpenClawConfig },
) => Promise<{ messageId: string; toJid: string }>;

type CreateWhatsAppOutboundBaseParams = {
  chunker: WhatsAppChunker;
  sendMessageWhatsApp: WhatsAppSendMessage;
  sendPollWhatsApp: WhatsAppSendPoll;
  shouldLogVerbose: () => boolean;
  resolveTarget: ChannelOutboundAdapter["resolveTarget"];
  normalizeText?: (text: string | undefined) => string;
  skipEmptyText?: boolean;
};

function resolveQuoteLookupAccountId(cfg?: OpenClawConfig, accountId?: string | null): string {
  const explicitAccountId = normalizeOptionalAccountId(accountId);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  const channelCfg = cfg?.channels?.whatsapp;
  const configuredIds = listCombinedAccountIds({
    configuredAccountIds:
      channelCfg?.accounts && typeof channelCfg.accounts === "object"
        ? Object.keys(channelCfg.accounts).filter(Boolean)
        : [],
    fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
  });
  return resolveListedDefaultAccountId({
    accountIds: configuredIds,
    configuredDefaultAccountId: normalizeOptionalAccountId(channelCfg?.defaultAccount),
  });
}

type WhatsAppOutboundBaseCore = Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "sanitizeText"
  | "deliveryCapabilities"
  | "pollMaxOptions"
  | "resolveTarget"
  | "sendText"
  | "sendMedia"
  | "sendPoll"
>;

export function createWhatsAppOutboundBase({
  chunker,
  sendMessageWhatsApp,
  sendPollWhatsApp,
  shouldLogVerbose,
  resolveTarget,
  normalizeText = normalizeWhatsAppPayloadText,
  skipEmptyText = true,
}: CreateWhatsAppOutboundBaseParams): Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "sanitizeText"
  | "deliveryCapabilities"
  | "pollMaxOptions"
  | "resolveTarget"
  | "sendPayload"
  | "sendText"
  | "sendMedia"
  | "sendPoll"
> {
  const resolveQuotedMessageKey = (params: {
    accountId: string;
    to: string;
    replyToId?: string | null;
  }) => {
    const replyToId = params.replyToId?.trim();
    if (!replyToId) {
      return undefined;
    }
    const targetJid = toWhatsappJid(params.to);
    const cachedMeta = lookupInboundMessageMetaForTarget(params.accountId, targetJid, replyToId);
    return {
      id: replyToId,
      remoteJid: cachedMeta?.remoteJid ?? targetJid,
      fromMe: cachedMeta?.fromMe ?? false,
      participant: cachedMeta?.participant,
      messageText: cachedMeta?.body,
    };
  };

  const outbound: WhatsAppOutboundBaseCore = {
    deliveryMode: "gateway",
    chunker,
    chunkerMode: "text",
    textChunkLimit: 4000,
    sanitizeText: ({ text }) => normalizeText(text),
    deliveryCapabilities: {
      durableFinal: {
        text: true,
        replyTo: true,
        messageSendingHooks: true,
      },
    },
    pollMaxOptions: 12,
    resolveTarget,
    ...createAttachedChannelResultAdapter({
      channel: "whatsapp",
      sendText: async ({ cfg, to, text, accountId, deps, gifPlayback, replyToId }) => {
        const normalizedText = normalizeText(text);
        if (skipEmptyText && !normalizedText) {
          return { messageId: "" };
        }
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
            legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
          }) ?? sendMessageWhatsApp;
        const lookupAccountId = resolveQuoteLookupAccountId(cfg, accountId);
        const quotedMessageKey = resolveQuotedMessageKey({
          accountId: lookupAccountId,
          to,
          replyToId,
        });
        return await send(to, normalizedText, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
          gifPlayback,
          quotedMessageKey,
        });
      },
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        audioAsVoice,
        accountId,
        deps,
        gifPlayback,
        forceDocument,
        replyToId,
      }) => {
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
            legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
          }) ?? sendMessageWhatsApp;
        const lookupAccountId = resolveQuoteLookupAccountId(cfg, accountId);
        const quotedMessageKey = resolveQuotedMessageKey({
          accountId: lookupAccountId,
          to,
          replyToId,
        });
        return await send(to, normalizeText(text), {
          verbose: false,
          cfg,
          mediaUrl,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          ...(audioAsVoice === undefined ? {} : { audioAsVoice }),
          accountId: accountId ?? undefined,
          gifPlayback,
          forceDocument,
          quotedMessageKey,
        });
      },
      sendPoll: async ({ cfg, to, poll, accountId }) =>
        await sendPollWhatsApp(to, poll, {
          verbose: shouldLogVerbose(),
          accountId: accountId ?? undefined,
          cfg,
        }),
    }),
  };
  return {
    ...outbound,
    sendPayload: async (ctx) => {
      if (ctx.payload.isError === true) {
        return { channel: "whatsapp", messageId: "" };
      }
      const payload = normalizeWhatsAppOutboundPayload(ctx.payload, { normalizeText });
      if (!payload.text && !(payload.mediaUrl || payload.mediaUrls?.length)) {
        if (ctx.payload.interactive || ctx.payload.presentation || ctx.payload.channelData) {
          throw new Error(
            "WhatsApp sendPayload does not support structured-only payloads without text or media.",
          );
        }
        return { channel: "whatsapp", messageId: "" };
      }
      return await sendTextMediaPayload({
        channel: "whatsapp",
        ctx: {
          ...ctx,
          payload,
        },
        adapter: outbound,
      });
    },
  };
}
