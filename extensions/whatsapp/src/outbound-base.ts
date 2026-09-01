// Whatsapp plugin module implements outbound base behavior.
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-core";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { resolveDefaultWhatsAppAccountId } from "./account-ids.js";
import {
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadText,
} from "./outbound-media-contract.js";
import { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";
import { lookupInboundMessageMetaForTarget } from "./quoted-message.js";
import { toWhatsappJid } from "./text-runtime.js";

type WhatsAppSendMessage = typeof import("./send.js").sendMessageWhatsApp;
type WhatsAppSendPoll = typeof import("./send.js").sendPollWhatsApp;

type CreateWhatsAppOutboundBaseParams = {
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
  return resolveDefaultWhatsAppAccountId(cfg ?? {});
}

type WhatsAppOutboundBaseCore = Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
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
  sendMessageWhatsApp,
  sendPollWhatsApp,
  shouldLogVerbose,
  resolveTarget,
  normalizeText = normalizeWhatsAppPayloadText,
  skipEmptyText = true,
}: CreateWhatsAppOutboundBaseParams): WhatsAppOutboundBaseCore &
  Pick<ChannelOutboundAdapter, "sendPayload"> {
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
      ...(cachedMeta && cachedMeta.remoteJid !== targetJid ? { lookupTargetJid: targetJid } : {}),
      messageText: cachedMeta?.body,
      media: cachedMeta?.media,
    };
  };

  const outbound: WhatsAppOutboundBaseCore = {
    deliveryMode: "gateway",
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
      sendText: async ({
        cfg,
        to,
        text,
        accountId,
        deps,
        gifPlayback,
        replyToId,
        replyToIdSource,
        replyToMode,
        formatting,
        onPlatformSendDispatch,
        onDeliveryResult,
      }) => {
        const normalizedText = normalizeText(text);
        if (skipEmptyText && !normalizedText) {
          return { messageId: "" };
        }
        const lookupAccountId = resolveQuoteLookupAccountId(cfg, accountId);
        const quotedMessageKey = resolveQuotedMessageKey({
          accountId: lookupAccountId,
          to,
          replyToId,
        });
        const send = quotedMessageKey
          ? sendMessageWhatsApp
          : (resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
              legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
            }) ?? sendMessageWhatsApp);
        return await send(to, normalizedText, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
          gifPlayback,
          replyToIdSource,
          replyToMode,
          formatting,
          onPlatformSendDispatch,
          ...(quotedMessageKey ? { quotedMessageKey } : {}),
          ...(onDeliveryResult
            ? {
                onDeliveryResult: async (result) => {
                  await onDeliveryResult(attachChannelToResult("whatsapp", result));
                },
              }
            : {}),
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
        replyToIdSource,
        replyToMode,
        formatting,
        onPlatformSendDispatch,
        onDeliveryResult,
      }) => {
        const lookupAccountId = resolveQuoteLookupAccountId(cfg, accountId);
        const quotedMessageKey = resolveQuotedMessageKey({
          accountId: lookupAccountId,
          to,
          replyToId,
        });
        const send = quotedMessageKey
          ? sendMessageWhatsApp
          : (resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
              legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
            }) ?? sendMessageWhatsApp);
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
          replyToIdSource,
          replyToMode,
          formatting,
          onPlatformSendDispatch,
          ...(quotedMessageKey ? { quotedMessageKey } : {}),
          ...(onDeliveryResult
            ? {
                onDeliveryResult: async (result) => {
                  await onDeliveryResult(attachChannelToResult("whatsapp", result));
                },
              }
            : {}),
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
