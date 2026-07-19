// Telegram plugin module implements outbound adapter behavior.
import type { OutboundDeliveryFormattingOptions } from "openclaw/plugin-sdk/channel-outbound";
import {
  resolveOutboundSendDep,
  sanitizeForPlainText,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  resolveSendableOutboundReplyParts,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { mergeTelegramAccountConfig, resolveDefaultTelegramAccountId } from "./accounts.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { splitTelegramHtmlChunks } from "./format.js";
import {
  canonicalizeTelegramPresentationPayload,
  resolveTelegramInteractiveTextFallback,
  TELEGRAM_PRESENTATION_CAPABILITIES,
} from "./interactive-fallback.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import {
  createTelegramPromptContextProjectionCursor,
  resolveTelegramPromptContextSource,
} from "./prompt-context-projection.js";
import { loadTelegramSendModule, type TelegramSendModule } from "./send-runtime.js";
import { normalizeTelegramOutboundTarget, parseTelegramTarget } from "./targets.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;
const TELEGRAM_POLL_OPTION_LIMIT = 12;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
type TelegramReactionFn = typeof import("./send.js").reactMessageTelegram;
type TelegramLocationFn = typeof import("./send.js").sendLocationTelegram;
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
  replyToIdSource?: TelegramSendOpts["replyToIdSource"];
  replyToMode?: TelegramSendOpts["replyToMode"];
  threadId?: string | number | null;
  formatting?: OutboundDeliveryFormattingOptions;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
  onDeliveryResult?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onDeliveryResult"];
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
    replyToIdSource?: TelegramSendOpts["replyToIdSource"];
    replyToMode?: TelegramSendOpts["replyToMode"];
    accountId?: string;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
    onDeliveryResult?: TelegramSendOpts["onDeliveryResult"];
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
      ...(params.replyToIdSource !== undefined ? { replyToIdSource: params.replyToIdSource } : {}),
      ...(params.replyToMode !== undefined ? { replyToMode: params.replyToMode } : {}),
      accountId: params.accountId ?? undefined,
      silent: params.silent,
      gatewayClientScopes: params.gatewayClientScopes,
      onDeliveryResult: params.onDeliveryResult
        ? async (result) => {
            await params.onDeliveryResult?.(attachChannelToResult("telegram", result));
          }
        : undefined,
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

type CreateTelegramOutboundAdapterOptions = {
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
  sendLocation: TelegramLocationFn;
  react: TelegramReactionFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const payload = canonicalizeTelegramPresentationPayload(params.payload, {
    allowWebAppButtons: parseTelegramTarget(params.to).chatType === "direct",
  });
  const telegramData = payload.channelData?.telegram as
    | {
        buttons?: TelegramInlineButtons;
        quoteText?: string;
        reaction?: { emoji?: unknown; replyToId?: unknown; replyToCurrent?: unknown };
      }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const reactionEmoji =
    typeof telegramData?.reaction?.emoji === "string" ? telegramData.reaction.emoji : undefined;
  const text =
    resolveTelegramInteractiveTextFallback({
      text: payload.text,
      interactive: payload.interactive,
      presentation: payload.presentation,
    }) ?? "";
  const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation: payload.presentation,
    interactive: payload.interactive,
  });
  const replyToMessageId = params.baseOpts.replyToMessageId;
  const promptContextSource = resolveTelegramPromptContextSource(params.payload);
  const projectionCursor = promptContextSource
    ? createTelegramPromptContextProjectionCursor(promptContextSource)
    : undefined;
  const projectionOptions = (finalPart: boolean) =>
    projectionCursor
      ? { promptContextProjectionPlan: { cursor: projectionCursor, finalPart } }
      : {};
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
    ...(payload.audioAsVoice === true ? { asVoice: true } : {}),
    ...(payload.videoAsNote === true ? { asVideoNote: true } : {}),
  };
  if (payload.location) {
    if (
      mediaUrls.length > 0 ||
      reactionEmoji ||
      payload.audioAsVoice === true ||
      payload.videoAsNote === true
    ) {
      throw new Error("Telegram location sends cannot be combined with media or reactions.");
    }
    if (text.trim()) {
      // Cross-context policy can add a required origin marker to an otherwise
      // standalone location. Persist it as a separate send without stealing
      // the location's native reply, quote, or buttons.
      await params.send(params.to, text, {
        ...params.baseOpts,
        replyToMessageId: undefined,
        replyToIdSource: undefined,
        replyToMode: undefined,
      });
    }
    return await params.sendLocation(params.to, payload.location, {
      ...params.baseOpts,
      ...projectionOptions(true),
      buttons,
      quoteText,
    });
  }
  if (payload.videoAsNote === true && mediaUrls.length !== 1) {
    throw new Error("Telegram video notes require exactly one media attachment.");
  }
  const shouldConsumeImplicitReplyTarget =
    payloadOpts.replyToIdSource === "implicit" &&
    payloadOpts.replyToMode !== undefined &&
    isSingleUseReplyToMode(payloadOpts.replyToMode);
  const consumedImplicitReplyPayloadOpts = shouldConsumeImplicitReplyTarget
    ? {
        ...payloadOpts,
        replyToMessageId: undefined,
        replyToIdSource: undefined,
        replyToMode: undefined,
      }
    : payloadOpts;
  let implicitReplyTargetAvailable = true;
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

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await params.send(params.to, text, {
        ...payloadOpts,
        ...projectionOptions(true),
        buttons,
      }),
    send: async ({ text: textLocal, mediaUrl, index, isFirst }) => {
      const mediaPayloadOpts =
        shouldConsumeImplicitReplyTarget && !implicitReplyTargetAvailable
          ? consumedImplicitReplyPayloadOpts
          : payloadOpts;
      implicitReplyTargetAvailable = false;
      return await params.send(params.to, textLocal, {
        ...mediaPayloadOpts,
        ...projectionOptions(index === mediaUrls.length - 1),
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      });
    },
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
    // Default Telegram delivery reparses this result as Markdown; use its bold
    // and strike delimiters. Rich accounts must keep the agent's HTML islands
    // (<details>, <tg-math-block>, checkbox lists) intact — the blocks emitter
    // owns them and keeps unsupported tags visibly literal, so tag-stripping
    // here would silently flatten the advertised rich contract.
    sanitizeText: ({ text, cfg, accountId }) =>
      cfg &&
      mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg))
        .richMessages === true
        ? sanitizeAssistantVisibleText(text)
        : sanitizeForPlainText(sanitizeAssistantVisibleText(text), { style: "markdown" }),
    shouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,
    beforeDeliverPayload: options.beforeDeliverPayload,
    shouldTreatDeliveredTextAsVisible: options.shouldTreatDeliveredTextAsVisible,
    targetsMatchForReplySuppression: options.targetsMatchForReplySuppression,
    preferFinalAssistantVisibleText: options.preferFinalAssistantVisibleText,
    presentationCapabilities: TELEGRAM_PRESENTATION_CAPABILITIES,
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
    renderPresentation: ({ payload, presentation, ctx }) =>
      canonicalizeTelegramPresentationPayload(
        { ...payload, presentation },
        { allowWebAppButtons: parseTelegramTarget(ctx.to ?? "").chatType === "direct" },
      ),
    afterDeliverPayload: ({ cfg, target, payload, results }) => {
      const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
      const telegramResults = results.filter(
        (candidate) => candidate.channel === "telegram" && candidate.messageId,
      );
      const result =
        telegramResults.find((candidate) => candidate.meta?.telegramHasInlineKeyboard === true) ??
        telegramResults.at(-1);
      const text = (
        typeof result?.meta?.telegramDeliveredText === "string"
          ? result.meta.telegramDeliveredText
          : payload.text
      )?.trim();
      if (!questionId || !result || !text) {
        return;
      }
      const chatId = result.chatId ?? normalizeTelegramOutboundTarget(target.to);
      questionGatewayRuntime.registerChannelDelivery({
        questionId,
        deliveryId: `telegram:${target.accountId ?? "default"}:${chatId}:${result.messageId}`,
        finalize: async (statusLine) => {
          const { editMessageTelegram } = await loadSendModule();
          await editMessageTelegram(chatId, result.messageId, `${text}\n\n${statusLine}`, {
            cfg,
            accountId: target.accountId ?? undefined,
            buttons: [],
            verbose: false,
          });
        },
      });
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
      const { reactMessageTelegram, sendLocationTelegram } = await loadSendModule();
      const result = await sendTelegramPayloadMessages({
        send,
        sendLocation: sendLocationTelegram,
        react: reactMessageTelegram,
        to: outboundTo,
        payload: params.payload,
        baseOpts: {
          ...baseOpts,
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
