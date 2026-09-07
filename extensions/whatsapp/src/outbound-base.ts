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
type WhatsAppSendOptions = Parameters<WhatsAppSendMessage>[2];
type WhatsAppDispatchParams = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

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

  const dispatchMessage = async (
    params: WhatsAppDispatchParams,
    text: string | undefined,
    mediaOptions?: Pick<
      WhatsAppSendOptions,
      "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile" | "audioAsVoice"
    >,
    mediaDeliveryOptions?: Pick<WhatsAppSendOptions, "forceDocument">,
  ) => {
    const lookupAccountId = resolveQuoteLookupAccountId(params.cfg, params.accountId);
    const quotedMessageKey = resolveQuotedMessageKey({
      accountId: lookupAccountId,
      to: params.to,
      replyToId: params.replyToId,
    });
    const send = quotedMessageKey
      ? sendMessageWhatsApp
      : (resolveOutboundSendDep<WhatsAppSendMessage>(params.deps, "whatsapp", {
          legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
        }) ?? sendMessageWhatsApp);
    const onDeliveryResult = params.onDeliveryResult;
    return await send(params.to, text ?? normalizeText(params.text), {
      verbose: false,
      cfg: params.cfg,
      ...mediaOptions,
      accountId: params.accountId ?? undefined,
      gifPlayback: params.gifPlayback,
      ...mediaDeliveryOptions,
      replyToIdSource: params.replyToIdSource,
      replyToMode: params.replyToMode,
      formatting: params.formatting,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      ...(quotedMessageKey ? { quotedMessageKey } : {}),
      ...(onDeliveryResult
        ? {
            onDeliveryResult: async (result) => {
              await onDeliveryResult(attachChannelToResult("whatsapp", result));
            },
          }
        : {}),
    });
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
      sendText: async (params) => {
        const normalizedText = normalizeText(params.text);
        if (skipEmptyText && !normalizedText) {
          return { messageId: "" };
        }
        return await dispatchMessage(params, normalizedText);
      },
      sendMedia: async (params) =>
        await dispatchMessage(
          params,
          undefined,
          {
            mediaUrl: params.mediaUrl,
            mediaAccess: params.mediaAccess,
            mediaLocalRoots: params.mediaLocalRoots,
            mediaReadFile: params.mediaReadFile,
            ...(params.audioAsVoice === undefined ? {} : { audioAsVoice: params.audioAsVoice }),
          },
          { forceDocument: params.forceDocument },
        ),
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
