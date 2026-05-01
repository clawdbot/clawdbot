import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/outbound-send-deps";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { markdownToTelegramHtmlChunks } from "./format.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { pinMessageTelegram } from "./send.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];

let telegramSendModulePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendModule() {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  gatewayClientScopes?: readonly string[];
}): Promise<{
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
    gatewayClientScopes?: readonly string[];
  };
}> {
  const send =
    resolveOutboundSendDep<TelegramSendFn>(params.deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram;
  return {
    send,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? undefined,
      gatewayClientScopes: params.gatewayClientScopes,
    },
  };
}

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const telegramData = params.payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const text =
    resolveTelegramInteractiveTextFallback({
      text: params.payload.text,
      interactive: params.payload.interactive,
    }) ?? "";
  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    interactive: params.payload.interactive,
  });
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
    ...(params.payload.audioAsVoice === true ? { asVoice: true } : {}),
  };

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await params.send(params.to, text, {
        ...payloadOpts,
        buttons,
      }),
    send: async ({ text, mediaUrl, isFirst }) =>
      await params.send(params.to, text, {
        ...payloadOpts,
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      }),
  });
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  extractMarkdownImages: true,
  textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: false,
  },
  deliveryCapabilities: {
    pin: true,
  },
  renderPresentation: ({ payload, presentation }) => ({
    ...payload,
    text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
    interactive: presentationToInteractiveReply(presentation),
  }),
  pinDeliveredMessage: async ({ cfg, target, messageId, pin }) => {
    await pinMessageTelegram(target.to, messageId, {
      cfg,
      accountId: target.accountId ?? undefined,
      notify: pin.notify,
      verbose: false,
    });
  },
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
  ...createAttachedChannelResultAdapter({
    channel: "telegram",
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      gatewayClientScopes,
    }) => {
      const { send, baseOpts } = await resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
      });
      return await send(to, text, {
        ...baseOpts,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      forceDocument,
      gatewayClientScopes,
    }) => {
      const { send, baseOpts } = await resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
      });
      return await send(to, text, {
        ...baseOpts,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        forceDocument: forceDocument ?? false,
      });
    },
  }),
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    replyToId,
    threadId,
    forceDocument,
    gatewayClientScopes,
  }) => {
    const { send, baseOpts } = await resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
      gatewayClientScopes,
    });
    const result = await sendTelegramPayloadMessages({
      send,
      to,
      payload,
      baseOpts: {
        ...baseOpts,
        mediaLocalRoots,
        mediaReadFile,
        forceDocument: forceDocument ?? false,
      },
    });
    return attachChannelToResult("telegram", result);
  },
};
