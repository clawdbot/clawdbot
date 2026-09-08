// Telegram plugin module implements outbound adapter behavior.
import type { OutboundDeliveryFormattingOptions } from "openclaw/plugin-sdk/channel-outbound";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { markTelegramDeliveryErrorVisible } from "./delivery-error.js";
import { splitTelegramHtmlChunks } from "./format.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { loadTelegramSendModule, type TelegramSendModule } from "./send-runtime.js";
import { normalizeTelegramOutboundTarget, parseTelegramTarget } from "./targets.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;
export const TELEGRAM_POLL_OPTION_LIMIT = 10;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
type TelegramReactionFn = typeof import("./send.js").reactMessageTelegram;
type ResolveTelegramSendFn = (deps?: OutboundSendDeps) => Promise<TelegramSendFn>;
type LoadTelegramSendModuleFn = () => Promise<TelegramSendModule>;

async function resolveDefaultTelegramSend(deps?: OutboundSendDeps): Promise<TelegramSendFn> {
  return (
    resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram
  );
}

function chunkTelegramOutboundText(
  text: string,
  limit: number,
  ctx?: { formatting?: OutboundDeliveryFormattingOptions },
): string[] {
  return ctx?.formatting?.parseMode === "HTML"
    ? splitTelegramHtmlChunks(text, limit)
    : chunkMarkdownTextWithMode(text, limit, ctx?.formatting?.chunkMode ?? "length");
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  replyToMode?: TelegramSendOpts["replyToMode"];
  replyToIdSource?: TelegramSendOpts["replyToIdSource"];
  threadId?: string | number | null;
  formatting?: OutboundDeliveryFormattingOptions;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
  resolveSend: ResolveTelegramSendFn;
}): Promise<{
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode?: "html";
    tableMode?: OutboundDeliveryFormattingOptions["tableMode"];
    messageThreadId?: number;
    replyToMessageId?: number;
    replyToMode?: TelegramSendOpts["replyToMode"];
    replyToIdSource?: TelegramSendOpts["replyToIdSource"];
    accountId?: string;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
  };
}> {
  const send = await params.resolveSend(params.deps);
  return {
    send,
    baseOpts: {
      verbose: false,
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      ...(params.replyToMode ? { replyToMode: params.replyToMode } : {}),
      ...(params.replyToIdSource ? { replyToIdSource: params.replyToIdSource } : {}),
      accountId: params.accountId ?? undefined,
      silent: params.silent,
      gatewayClientScopes: params.gatewayClientScopes,
      ...(params.formatting?.parseMode === "HTML" ? { textMode: "html" as const } : {}),
      tableMode: params.formatting?.tableMode,
    },
  };
}

async function resolveTelegramOutboundSendContext(
  params: Parameters<typeof resolveTelegramSendContext>[0] & { to: string },
) {
  const outboundTo = normalizeTelegramOutboundTarget(params.to);
  const { send, baseOpts } = await resolveTelegramSendContext(params);
  return { outboundTo, send, baseOpts };
}

export type CreateTelegramOutboundAdapterOptions = {
  resolveSend?: ResolveTelegramSendFn;
  loadSendModule?: LoadTelegramSendModuleFn;
  beforeDeliverPayload?: ChannelOutboundAdapter["beforeDeliverPayload"];
  shouldSuppressLocalPayloadPrompt?: ChannelOutboundAdapter["shouldSuppressLocalPayloadPrompt"];
  shouldTreatDeliveredTextAsVisible?: ChannelOutboundAdapter["shouldTreatDeliveredTextAsVisible"];
  targetsMatchForReplySuppression?: ChannelOutboundAdapter["targetsMatchForReplySuppression"];
  preferFinalAssistantVisibleText?: boolean;
};

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  react: TelegramReactionFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const telegramData = params.payload.channelData?.telegram as
    | {
        buttons?: TelegramInlineButtons;
        quoteText?: string;
        reaction?: { emoji?: unknown; replyToId?: unknown; replyToCurrent?: unknown };
        standardMessage?: boolean;
      }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const reactionEmoji =
    typeof telegramData?.reaction?.emoji === "string" ? telegramData.reaction.emoji : undefined;
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  const text =
    resolveTelegramInteractiveTextFallback({
      text: params.payload.text,
      interactive: params.payload.interactive,
      presentation,
    }) ?? "";
  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation,
    interactive: params.payload.interactive,
  });
  const replyToMessageId = params.baseOpts.replyToMessageId;
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
    standardMessage: telegramData?.standardMessage === true,
    ...(params.payload.audioAsVoice === true ? { asVoice: true } : {}),
  };
  if (reactionEmoji) {
    if (typeof replyToMessageId !== "number") {
      throw new Error("Telegram reaction requires a reply target");
    }
    const reactionResult = await params.react(params.to, replyToMessageId, reactionEmoji, {
      cfg: params.baseOpts.cfg,
      accountId: params.baseOpts.accountId,
      gatewayClientScopes: params.baseOpts.gatewayClientScopes,
      verbose: false,
    });
    if (!reactionResult.ok) {
      throw new Error(reactionResult.warning);
    }
  }
  if (reactionEmoji && !text && mediaUrls.length === 0 && !buttons?.length) {
    return { messageId: String(replyToMessageId), chatId: params.to };
  }

  const singleUseImplicitReply =
    payloadOpts.standardMessage &&
    payloadOpts.replyToMessageId != null &&
    payloadOpts.replyToIdSource !== "explicit" &&
    payloadOpts.replyToMode != null &&
    isSingleUseReplyToMode(payloadOpts.replyToMode);
  let implicitReplyAvailable = true;
  let deliveredSendCount = 0;
  const sendWithReplyFanout = async (textLocal: string, options: TelegramSendOpts) => {
    const effectiveOptions =
      singleUseImplicitReply && !implicitReplyAvailable
        ? { ...options, replyToMessageId: undefined }
        : options;
    let result: Awaited<ReturnType<TelegramSendFn>>;
    try {
      result = await params.send(params.to, textLocal, effectiveOptions);
    } catch (error) {
      if (deliveredSendCount > 0) {
        throw markTelegramDeliveryErrorVisible(error);
      }
      throw error;
    }
    deliveredSendCount += 1;
    if (singleUseImplicitReply && effectiveOptions.replyToMessageId != null) {
      implicitReplyAvailable = false;
    }
    return result;
  };

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await sendWithReplyFanout(text, {
        ...payloadOpts,
        buttons,
      }),
    send: async ({ text: textLocal, mediaUrl, isFirst }) =>
      await sendWithReplyFanout(textLocal, {
        ...payloadOpts,
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      }),
  });
}

export function createTelegramOutboundAdapter(
  options: CreateTelegramOutboundAdapterOptions = {},
): ChannelOutboundAdapter {
  const resolveSend = options.resolveSend ?? resolveDefaultTelegramSend;
  const loadSendModule = options.loadSendModule ?? loadTelegramSendModule;

  return {
    deliveryMode: "direct",
    chunker: chunkTelegramOutboundText,
    chunkerMode: "markdown",
    extractMarkdownImages: true,
    textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
    shouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,
    beforeDeliverPayload: options.beforeDeliverPayload,
    shouldTreatDeliveredTextAsVisible: options.shouldTreatDeliveredTextAsVisible,
    targetsMatchForReplySuppression: options.targetsMatchForReplySuppression,
    preferFinalAssistantVisibleText: options.preferFinalAssistantVisibleText,
    presentationCapabilities: {
      supported: true,
      buttons: true,
      selects: true,
      context: true,
      divider: false,
      limits: {
        actions: {
          maxActions: 100,
          maxActionsPerRow: 3,
          maxLabelLength: 64,
          supportsStyles: false,
        },
        selects: {
          maxOptions: 100,
          maxLabelLength: 64,
        },
        text: {
          markdownDialect: "markdown",
        },
      },
    },
    deliveryCapabilities: {
      pin: true,
      durableFinal: {
        text: true,
        media: true,
        payload: true,
        silent: true,
        replyTo: true,
        thread: true,
        nativeQuote: false,
        messageSendingHooks: true,
        batch: true,
      },
    },
    renderPresentation: ({ payload, presentation }) => {
      const telegramData = payload.channelData?.telegram as Record<string, unknown> | undefined;
      const hasExplicitButtons = (telegramData && "buttons" in telegramData) || payload.interactive;
      const buttons = hasExplicitButtons
        ? undefined
        : resolveTelegramInlineButtons({ presentation });
      return {
        ...payload,
        text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
        channelData: {
          ...payload.channelData,
          telegram: {
            ...telegramData,
            ...(buttons ? { buttons } : {}),
          },
        },
      };
    },
    pinDeliveredMessage: async ({ cfg, target, messageId, pin, gatewayClientScopes }) => {
      const { pinMessageTelegram } = await loadSendModule();
      const outboundTo = normalizeTelegramOutboundTarget(target.to);
      const pinTarget = parseTelegramTarget(outboundTo);
      await pinMessageTelegram(pinTarget.chatId, messageId, {
        cfg,
        accountId: target.accountId ?? undefined,
        notify: pin.notify,
        verbose: false,
        gatewayClientScopes,
      });
    },
    resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
      typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
    pollMaxOptions: TELEGRAM_POLL_OPTION_LIMIT,
    supportsPollDurationSeconds: true,
    supportsAnonymousPolls: true,
    ...createAttachedChannelResultAdapter({
      channel: "telegram",
      sendText: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return await send(outboundTo, params.text, {
          ...baseOpts,
        });
      },
      sendMedia: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return await send(outboundTo, params.text, {
          ...baseOpts,
          mediaUrl: params.mediaUrl,
          ...(params.mediaAccess !== undefined ? { mediaAccess: params.mediaAccess } : {}),
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          forceDocument: params.forceDocument ?? false,
        });
      },
    }),
    sendPayload: async (params) => {
      const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
        ...params,
        resolveSend,
      });
      const { reactMessageTelegram } = await loadSendModule();
      const result = await sendTelegramPayloadMessages({
        send,
        react: reactMessageTelegram,
        to: outboundTo,
        payload: params.payload,
        baseOpts: {
          ...baseOpts,
          ...(params.mediaAccess !== undefined ? { mediaAccess: params.mediaAccess } : {}),
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          forceDocument: params.forceDocument ?? false,
        },
      });
      return attachChannelToResult("telegram", result);
    },
    sendPoll: async ({
      cfg,
      to,
      poll,
      accountId,
      threadId,
      silent,
      isAnonymous,
      gatewayClientScopes,
    }) => {
      const outboundTo = normalizeTelegramOutboundTarget(to);
      const { sendPollTelegram } = await loadSendModule();
      return await sendPollTelegram(outboundTo, poll, {
        cfg,
        accountId: accountId ?? undefined,
        messageThreadId: parseTelegramThreadId(threadId),
        silent: silent ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
        gatewayClientScopes,
      });
    },
  };
}

export const telegramOutbound: ChannelOutboundAdapter = createTelegramOutboundAdapter();
