// Telegram plugin module implements delivery.replies behavior.
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDirectAcceptedFencedMediaWarnLatch } from "openclaw/plugin-sdk/channel-outbound-fenced-media-runtime";
import type { MarkdownTableMode, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import {
  buildCanonicalSentMessageHookContext,
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import type { ReplyPayloadDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  buildOutboundMediaLoadOptions,
  probeVideoDimensions,
} from "openclaw/plugin-sdk/media-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "../button-types.js";
import {
  createTelegramChunkDeliveryTracker,
  mergeTelegramPartialDeliveryError,
} from "../chunk-delivery.js";
import {
  canonicalizeTelegramPresentationPayload,
  resolveTelegramInteractiveTextFallback,
} from "../interactive-fallback.js";
import {
  prepareTelegramOutboundMedia,
  resolveTelegramOutboundMediaSenders,
  sendTelegramCaptionedMediaWithFallback,
  sendTelegramOutboundMediaWithPhotoFallback,
  type TelegramOutboundMediaSender,
} from "../outbound-media.js";
import type { TelegramPromptContextProjectionSequence } from "../prompt-context-projection.js";
import { TELEGRAM_RICH_TEXT_LIMIT } from "../rich-message.js";
import { isTelegramEmptyContentError } from "../rich-plain-fallback.js";
import {
  isTelegramCaptionTooLongError,
  isTelegramPhotoLimitError,
  isTelegramVoiceMessagesForbiddenError,
} from "../send-error-predicates.js";
import { reportTelegramProviderDelivery } from "../send-outbound.js";
import { buildInlineKeyboard, reactMessageTelegram } from "../send.js";
import { recordSentMessage } from "../sent-message-cache.js";
import { resolveTelegramTargetChatType } from "../targets.js";
import {
  planTelegramTextDeliveryPages,
  type TelegramTextDeliveryPage,
} from "../telegram-text-delivery.js";
import {
  buildTelegramSendParams,
  sendTelegramText,
  sendTelegramWithThreadFallback,
} from "./delivery.send.js";
import { resolveTelegramReplyId, type TelegramThreadSpec } from "./helpers.js";
import type { TelegramNativeQuoteCandidateByMessageId } from "./native-quote.js";

type DeliveryProgress = {
  hasReplied: boolean;
  hasDelivered: boolean;
  deliveredCount: number;
  promptContext?: TelegramPromptContextProjectionSequence;
};

type TelegramReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
  reaction?: {
    emoji?: unknown;
  };
};

type TelegramReplyQuoteForSend = {
  messageId?: number;
  text?: string;
  position?: number;
  entities?: unknown[];
};

type ChunkTextFn = (text: string) => TelegramTextDeliveryPage[];

function markDelivered(progress: DeliveryProgress): void {
  progress.hasDelivered = true;
  progress.deliveredCount += 1;
}

function resolveReplyToForSend(params: {
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): number | undefined {
  return params.replyToId && (params.replyToMode === "all" || !params.progress.hasReplied)
    ? params.replyToId
    : undefined;
}

function markReplyApplied(progress: DeliveryProgress, replyToId?: number): void {
  if (replyToId && !progress.hasReplied) {
    progress.hasReplied = true;
  }
}

function filterEmptyTelegramTextChunks(chunks: readonly TelegramTextDeliveryPage[]) {
  // Telegram rejects whitespace-only text payloads; drop them before sendMessage so
  // hook-mutated or model-emitted empty replies become a no-op instead of a 400.
  // Rich chunks gate on the rich payload: valid rich content (media/divider HTML)
  // can have an empty plain projection and must still send.
  return chunks.filter(
    (chunk) => chunk.richMessage?.blocks.length || chunk.htmlText?.trim() || chunk.plainText.trim(),
  );
}

function resolveReplyQuoteForSend(params: {
  replyToId?: number;
  replyQuoteByMessageId?: TelegramNativeQuoteCandidateByMessageId;
  replyQuoteMessageId?: number;
  replyQuoteText?: string;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
}): TelegramReplyQuoteForSend {
  if (params.replyToId != null) {
    const mapped = params.replyQuoteByMessageId?.[String(params.replyToId)];
    if (mapped?.text) {
      const quote: TelegramReplyQuoteForSend = {
        messageId: params.replyToId,
        text: mapped.text,
      };
      if (typeof mapped.position === "number") {
        quote.position = mapped.position;
      }
      if (mapped.entities) {
        quote.entities = mapped.entities;
      }
      return quote;
    }
  }
  const quote: TelegramReplyQuoteForSend = {};
  if (params.replyQuoteMessageId != null) {
    quote.messageId = params.replyQuoteMessageId;
  }
  if (params.replyQuoteText != null) {
    quote.text = params.replyQuoteText;
  }
  if (params.replyQuotePosition != null) {
    quote.position = params.replyQuotePosition;
  }
  if (params.replyQuoteEntities != null) {
    quote.entities = params.replyQuoteEntities;
  }
  return quote;
}

async function deliverTextReply(params: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  chunkText: ChunkTextFn;
  text: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteMessageId?: number;
  replyQuoteText?: string;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
  richMessages?: boolean;
  tableMode?: MarkdownTableMode;
  linkPreview?: boolean;
  silent?: boolean;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
  recordMessageId: (messageId: number) => void;
  quoteOnlyOnFirstChunk?: boolean;
  onPlatformSendDispatch?: () => Promise<void>;
  /** After each accepted Bot API text chunk (#41966 fenced MEDIA diagnostic). */
  onAcceptedVisibleText?: (plainText: string) => void;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  const chunks = filterEmptyTelegramTextChunks(params.chunkText(params.text));
  const messageIds: string[] = [];
  const tracker = createTelegramChunkDeliveryTracker({
    invalidate: () => params.progress.promptContext?.invalidate(),
    onRejected: (error) =>
      params.runtime.error?.(
        danger(`telegram reply chunk rejected; continuing: ${formatErrorMessage(error)}`),
      ),
    isSilentSkip: isTelegramEmptyContentError,
    onSilentSkip: (error) =>
      params.runtime.log?.(
        `telegram reply chunk rendered empty; skipping: ${formatErrorMessage(error)}`,
      ),
    partialDeliveryResult: () => ({ messageIds: [...messageIds], visibleReplySent: true }),
  });
  const suppressReply = chunks.length > 1 && isSingleUseReplyToMode(params.replyToMode);
  let hasAcceptedChunk = false;
  for (const chunk of chunks) {
    const first = !hasAcceptedChunk;
    const replyToMessageId = suppressReply ? undefined : resolveReplyToForSend(params);
    const includeQuote = params.quoteOnlyOnFirstChunk !== true || first;
    try {
      await params.onPlatformSendDispatch?.();
      await sendTelegramText(
        params.bot,
        params.chatId,
        chunk.htmlText ?? chunk.plainText,
        params.runtime,
        {
          replyToMessageId,
          replyQuoteMessageId: includeQuote ? params.replyQuoteMessageId : undefined,
          replyQuoteText: replyToMessageId && includeQuote ? params.replyQuoteText : undefined,
          replyQuotePosition: includeQuote ? params.replyQuotePosition : undefined,
          replyQuoteEntities: includeQuote ? params.replyQuoteEntities : undefined,
          thread: params.thread,
          textMode: chunk.htmlText ? "html" : "markdown",
          plainText: chunk.plainText,
          richMessages: params.richMessages,
          richMessage: chunk.richMessage,
          richDegradationReasons: chunk.degradationReasons,
          linkPreview: params.linkPreview,
          tableMode: params.tableMode,
          silent: params.silent,
          replyMarkup: first ? params.replyMarkup : undefined,
          onAcceptedMessage: async (messageId, plainText) => {
            messageIds.push(String(messageId));
            await tracker.recordAccepted(messageId, async () => {
              firstDeliveredMessageId ??= messageId;
              params.recordMessageId(messageId);
              await params.progress.promptContext?.accept({ messageId, text: plainText });
              params.onAcceptedVisibleText?.(plainText);
            });
          },
        },
      );
    } catch (error) {
      tracker.reject(error);
      continue;
    }
    hasAcceptedChunk = true;
    markReplyApplied(params.progress, suppressReply && first ? params.replyToId : replyToMessageId);
    markDelivered(params.progress);
  }
  tracker.finish();
  return firstDeliveredMessageId;
}

function resolveVoiceFallbackText(reply: ReplyPayload): string | undefined {
  if (reply.text?.trim()) {
    return reply.text;
  }
  if (reply.spokenText?.trim()) {
    return reply.spokenText;
  }
  return undefined;
}

async function deliverMediaReply(params: {
  reply: ReplyPayload;
  mediaList: string[];
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  richMessages?: boolean;
  mediaLocalRoots?: readonly string[];
  mediaMaxBytes?: number;
  chunkText: ChunkTextFn;
  mediaLoader: typeof loadWebMedia;
  onVoiceRecording?: () => Promise<void> | void;
  linkPreview?: boolean;
  silent?: boolean;
  replyQuoteMessageId?: number;
  replyQuoteText?: string;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
  recordMessageId: (messageId: number) => void;
  textMode?: "html";
  onPlatformSendDispatch?: () => Promise<void>;
  onAcceptedVisibleText?: (plainText: string) => void;
}): Promise<{ firstDeliveredMessageId?: number; visibleFallbackText?: string }> {
  let firstDeliveredMessageId: number | undefined;
  let visibleFallbackText: string | undefined;
  let firstDeliveredCaption: string | undefined;
  const deliveredMediaMessageIds: string[] = [];
  let first = true;
  let pendingFollowUpText: string | undefined;
  const recordPromptContextMessage = async (message: Message, text?: string) => {
    const promptContextMessage = {
      messageId: message.message_id,
      message,
      ...(text ? { text } : {}),
    };
    await params.progress.promptContext?.accept(promptContextMessage);
  };
  const deliverAcceptedMedia = async (options: {
    sender: TelegramOutboundMediaSender<Message>;
    requestParams: Record<string, unknown>;
    plainCaption?: string;
    shouldLog?: (err: unknown) => boolean;
  }) => {
    await params.onPlatformSendDispatch?.();
    const delivery = await sendTelegramCaptionedMediaWithFallback({
      operation: options.sender.operation,
      requestParams: options.requestParams,
      plainCaption: options.plainCaption,
      shouldLog: options.shouldLog,
      send: (requestParams, shouldLog) =>
        sendTelegramWithThreadFallback({
          operation: options.sender.operation,
          runtime: params.runtime,
          requestParams,
          ...(shouldLog ? { shouldLog } : {}),
          send: options.sender.send,
        }),
    });
    const message = delivery.result;
    if (params.thread?.id !== undefined) {
      try {
        await reportTelegramProviderDelivery({
          message,
          messageId: message.message_id,
          fallbackChatId: params.chatId,
          successfulSendThread: params.thread,
        });
      } catch (error) {
        throw mergeTelegramPartialDeliveryError(error, {
          messageIds: deliveredMediaMessageIds,
          visibleReplySent: true,
        });
      }
    }
    firstDeliveredMessageId ??= message.message_id;
    firstDeliveredCaption ??= delivery.deliveredCaption;
    if (delivery.captionRemoved) {
      visibleFallbackText = "";
    }
    deliveredMediaMessageIds.push(String(message.message_id));
    params.recordMessageId(message.message_id);
    await recordPromptContextMessage(message, delivery.deliveredCaption);
    markDelivered(params.progress);
    // Caption-bearing accepted media send can retain fenced MEDIA identity (#41966).
    if (options.plainCaption?.trim() && !delivery.captionRemoved) {
      params.onAcceptedVisibleText?.(options.plainCaption);
    }
  };
  const throwMediaPartial = (error: unknown): never => {
    throw mergeTelegramPartialDeliveryError(error, {
      messageIds: deliveredMediaMessageIds,
      visibleReplySent: true,
    });
  };
  const createVoiceFallbackProgress = (): DeliveryProgress => ({
    hasReplied: false,
    hasDelivered: false,
    deliveredCount: 0,
    ...(params.progress.promptContext ? { promptContext: params.progress.promptContext } : {}),
  });
  for (const mediaUrl of params.mediaList) {
    const isFirstMedia = first;
    const media = await params.mediaLoader(
      mediaUrl,
      buildOutboundMediaLoadOptions({
        mediaLocalRoots: params.mediaLocalRoots,
        maxBytes: params.mediaMaxBytes,
      }),
    );
    const mediaPlan = prepareTelegramOutboundMedia({
      media,
      text: isFirstMedia ? (params.reply.text ?? undefined) : undefined,
      textMode: params.textMode,
      tableMode: params.tableMode,
      preparedHtml: true,
    });
    const { sender: mediaSender, documentSender } = resolveTelegramOutboundMediaSenders<Message>({
      api: params.bot.api,
      chatId: params.chatId,
      media,
      plan: mediaPlan,
      asVoice: params.reply.audioAsVoice,
    });
    const { htmlCaption, plainCaption, followUpText } = mediaPlan;
    if (followUpText) {
      pendingFollowUpText = followUpText;
    }
    first = false;
    const replyToMessageId = resolveReplyToForSend({
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      progress: params.progress,
    });
    const shouldAttachButtonsToMedia = isFirstMedia && params.replyMarkup && !followUpText;
    const videoDimensions =
      mediaPlan.kind === "video" ? await probeVideoDimensions(media.buffer) : undefined;
    const mediaParams: Record<string, unknown> = {
      caption: htmlCaption,
      ...(htmlCaption ? { parse_mode: "HTML" } : {}),
      ...(shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {}),
      ...(videoDimensions ? { width: videoDimensions.width, height: videoDimensions.height } : {}),
      ...buildTelegramSendParams({
        replyToMessageId,
        replyQuoteMessageId: params.replyQuoteMessageId,
        replyQuoteText: params.replyQuoteText,
        replyQuotePosition: params.replyQuotePosition,
        replyQuoteEntities: params.replyQuoteEntities,
        thread: params.thread,
        silent: params.silent,
      }),
    };
    if (mediaSender.label === "voice") {
      const sendVoiceMedia = async (
        requestParams: typeof mediaParams,
        shouldLog?: (err: unknown) => boolean,
      ) => {
        const hasCaption = typeof requestParams.caption === "string";
        await deliverAcceptedMedia({
          sender: mediaSender,
          requestParams,
          plainCaption: hasCaption ? plainCaption : undefined,
          shouldLog,
        });
      };
      const sendVoiceFallbackText = async (
        text: string,
        options: { replyToId?: number; includeQuote?: boolean; replyToMode?: ReplyToMode } = {},
      ) =>
        await deliverTextReply({
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          text,
          chunkText: params.chunkText,
          replyToId: options.replyToId,
          ...(options.includeQuote
            ? {
                replyQuoteMessageId: params.replyQuoteMessageId,
                replyQuotePosition: params.replyQuotePosition,
                replyQuoteEntities: params.replyQuoteEntities,
                replyQuoteText: params.replyQuoteText,
              }
            : {}),
          thread: params.thread,
          richMessages: params.richMessages,
          tableMode: params.tableMode,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyMarkup: params.replyMarkup,
          replyToMode: options.replyToMode ?? params.replyToMode,
          progress: createVoiceFallbackProgress(),
          recordMessageId: params.recordMessageId,
          quoteOnlyOnFirstChunk: true,
          onPlatformSendDispatch: params.onPlatformSendDispatch,
          onAcceptedVisibleText: params.onAcceptedVisibleText,
        });

      await params.onVoiceRecording?.();
      try {
        await sendVoiceMedia(mediaParams, (err) => !isTelegramVoiceMessagesForbiddenError(err));
      } catch (voiceErr) {
        if (isTelegramVoiceMessagesForbiddenError(voiceErr)) {
          const fallbackText = resolveVoiceFallbackText(params.reply);
          if (!fallbackText || !fallbackText.trim()) {
            throw voiceErr;
          }
          logVerbose(
            "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text",
          );
          const voiceFallbackReplyTo = resolveReplyToForSend({
            replyToId: params.replyToId,
            replyToMode: params.replyToMode,
            progress: params.progress,
          });
          const fallbackMessageId = await sendVoiceFallbackText(fallbackText, {
            replyToId: voiceFallbackReplyTo,
            includeQuote: true,
          });
          if (fallbackMessageId === undefined) {
            throw voiceErr;
          }
          firstDeliveredMessageId ??= fallbackMessageId;
          visibleFallbackText = fallbackText;
          markReplyApplied(params.progress, voiceFallbackReplyTo);
          markDelivered(params.progress);
          continue;
        }
        if (isTelegramCaptionTooLongError(voiceErr)) {
          logVerbose(
            "telegram sendVoice caption too long; resending voice without caption + text separately",
          );
          const noCaptionParams = { ...mediaParams };
          delete noCaptionParams.caption;
          delete noCaptionParams.parse_mode;
          await sendVoiceMedia(noCaptionParams);
          const fallbackText = resolveVoiceFallbackText(params.reply);
          if (fallbackText?.trim()) {
            try {
              const fallbackMessageId = await sendVoiceFallbackText(fallbackText, {
                replyToMode: "first",
              });
              if (fallbackMessageId !== undefined) {
                visibleFallbackText = fallbackText;
              }
            } catch (fallbackError) {
              if (!isTelegramEmptyContentError(fallbackError)) {
                throw fallbackError;
              }
              visibleFallbackText = "";
            }
          }
          markReplyApplied(params.progress, replyToMessageId);
          continue;
        }
        throw voiceErr;
      }
    } else {
      await sendTelegramOutboundMediaWithPhotoFallback({
        sender: mediaSender,
        documentSender,
        send: (sender) =>
          deliverAcceptedMedia({
            sender,
            requestParams: mediaParams,
            plainCaption,
            ...(sender.label === "photo"
              ? { shouldLog: (error: unknown) => !isTelegramPhotoLimitError(error) }
              : {}),
          }),
      });
    }
    markReplyApplied(params.progress, replyToMessageId);
    if (pendingFollowUpText && isFirstMedia) {
      try {
        const followUpMessageId = await deliverTextReply({
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          chunkText: params.chunkText,
          text: pendingFollowUpText,
          replyMarkup: params.replyMarkup,
          richMessages: params.richMessages,
          tableMode: params.tableMode,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyToId: params.replyToId,
          replyToMode: params.replyToMode,
          progress: params.progress,
          recordMessageId: params.recordMessageId,
          onPlatformSendDispatch: params.onPlatformSendDispatch,
          onAcceptedVisibleText: params.onAcceptedVisibleText,
        });
        if (followUpMessageId === undefined) {
          visibleFallbackText = firstDeliveredCaption ?? "";
        } else {
          visibleFallbackText = undefined;
        }
      } catch (error) {
        if (!isTelegramEmptyContentError(error)) {
          throwMediaPartial(error);
        }
        visibleFallbackText = firstDeliveredCaption ?? "";
        if (params.replyMarkup && firstDeliveredMessageId !== undefined) {
          try {
            await params.bot.api.editMessageReplyMarkup(params.chatId, firstDeliveredMessageId, {
              reply_markup: params.replyMarkup,
            });
          } catch (keyboardError) {
            throwMediaPartial(keyboardError);
          }
        }
      }
      pendingFollowUpText = undefined;
    }
  }
  return { firstDeliveredMessageId, visibleFallbackText };
}

async function maybePinFirstDeliveredMessage(params: {
  pin: ReplyPayloadDelivery["pin"];
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  firstDeliveredMessageId?: number;
}): Promise<void> {
  const shouldPin = params.pin === true || (typeof params.pin === "object" && params.pin.enabled);
  if (!shouldPin || typeof params.firstDeliveredMessageId !== "number") {
    return;
  }
  const notify = typeof params.pin === "object" && params.pin.notify === true;
  try {
    await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, {
      disable_notification: !notify,
    });
  } catch (err) {
    logVerbose(
      `telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(err)}`,
    );
  }
}

type EmitMessageSentHookParams = {
  sessionKeyForInternalHooks?: string;
  chatId: string;
  accountId?: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: number;
  isGroup?: boolean;
  groupId?: string;
};

function buildTelegramSentHookContext(params: EmitMessageSentHookParams) {
  return buildCanonicalSentMessageHookContext({
    to: params.chatId,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "telegram",
    accountId: params.accountId,
    conversationId: params.chatId,
    messageId: typeof params.messageId === "number" ? String(params.messageId) : undefined,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
}

function emitInternalMessageSentHook(params: EmitMessageSentHookParams): void {
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildTelegramSentHookContext(params);
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "telegram: message:sent internal hook failed",
  );
}

function emitMessageSentHooks(
  params: EmitMessageSentHookParams & {
    hookRunner: ReturnType<typeof getGlobalHookRunner>;
    enabled: boolean;
  },
): void {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildTelegramSentHookContext(params);
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "telegram: message_sent plugin hook failed",
    );
  }
  emitInternalMessageSentHook(params);
}

export function emitTelegramMessageSentHooks(params: EmitMessageSentHookParams): void {
  const hookRunner = getGlobalHookRunner();
  emitMessageSentHooks({
    ...params,
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sent") ?? false,
  });
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  cfg?: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
  ownerAgentId?: string;
  chatId: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  policySessionKey?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  mediaLocalRoots?: readonly string[];
  mediaMaxBytes?: number;
  replyToMode: ReplyToMode;
  textLimit: number;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Opt into Telegram Bot API 10.2 rich text delivery. */
  richMessages?: boolean;
  /** Callback invoked before sending a voice message to switch typing indicator. */
  onVoiceRecording?: () => Promise<void> | void;
  /** Controls whether link previews are shown. Default: true (previews enabled). */
  linkPreview?: boolean;
  /** When true, messages are sent with disable_notification. */
  silent?: boolean;
  /** Message id that the optional quote text belongs to. */
  replyQuoteMessageId?: number;
  /** Optional quote text for Telegram reply_parameters. */
  replyQuoteText?: string;
  /** UTF-16 position of the selected quote in the original Telegram message. */
  replyQuotePosition?: number;
  /** Telegram entities that belong to the selected quote text. */
  replyQuoteEntities?: unknown[];
  /** Native Telegram quote candidates keyed by message id. */
  replyQuoteByMessageId?: TelegramNativeQuoteCandidateByMessageId;
  /** Override media loader (tests). */
  mediaLoader?: typeof loadWebMedia;
  transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  promptContextSequence?: TelegramPromptContextProjectionSequence;
  /** Text is already prepared Telegram HTML and must not be parsed as Markdown again. */
  textMode?: "html";
  /** @internal Claim delivery custody immediately before Telegram Bot API I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<{
  delivered: boolean;
}> {
  const progress: DeliveryProgress = {
    hasReplied: false,
    hasDelivered: false,
    deliveredCount: 0,
    ...(params.promptContextSequence ? { promptContext: params.promptContextSequence } : {}),
  };
  const recordMessageId = (messageId: number) => {
    if (params.accountId || params.ownerAgentId) {
      recordSentMessage(params.chatId, messageId, params.cfg, {
        accountId: params.accountId,
        agentId: params.ownerAgentId,
      });
      return;
    }
    recordSentMessage(params.chatId, messageId, params.cfg);
  };
  const mediaLoader = params.mediaLoader ?? loadWebMedia;
  const transcriptMirror = params.transcriptMirror;
  const deliveredContents: Array<{ text: string; mediaUrls: string[] }> = [];
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const chunkText: ChunkTextFn = (text) =>
    planTelegramTextDeliveryPages({
      text,
      maxChars:
        params.richMessages === true
          ? Math.min(params.textLimit, TELEGRAM_RICH_TEXT_LIMIT)
          : Math.min(params.textLimit, 4000),
      chunkMode: params.chunkMode ?? "length",
      tableMode: params.tableMode,
      richMessages: params.richMessages,
      skipEntityDetection: params.linkPreview === false,
      ...(params.textMode ? { textMode: params.textMode } : {}),
    });
  const candidateReplies: ReplyPayload[] = [];
  for (const reply of params.replies) {
    if (!reply || typeof reply !== "object") {
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }
    candidateReplies.push(reply);
  }
  const normalizedReplies = projectOutboundPayloadPlanForDelivery(
    createOutboundPayloadPlan(candidateReplies, {
      cfg: params.cfg,
      sessionKey: params.policySessionKey ?? params.sessionKeyForInternalHooks,
      surface: "telegram",
    }),
  );
  for (const originalReply of normalizedReplies) {
    let reply = canonicalizeTelegramPresentationPayload(originalReply, {
      allowWebAppButtons: resolveTelegramTargetChatType(params.chatId) === "direct",
      // HTML-mode text bypasses the markdown -> rich-block converter, so native
      // table rendering only applies to the rich markdown funnel.
      richTables: params.richMessages === true && params.textMode !== "html",
    });
    const mediaList = reply?.mediaUrls?.length
      ? reply.mediaUrls
      : reply?.mediaUrl
        ? [reply.mediaUrl]
        : [];
    const hasMedia = mediaList.length > 0;
    const presentation = normalizeMessagePresentation(reply?.presentation);
    const interactive = reply?.interactive;
    const resolvedReplyText =
      resolveTelegramInteractiveTextFallback({
        text: reply?.text,
        interactive,
        presentation,
      }) ??
      reply?.text ??
      "";
    if (reply && resolvedReplyText !== (reply.text ?? "")) {
      reply = { ...reply, text: resolvedReplyText };
    }
    const telegramData = reply.channelData?.telegram as TelegramReplyChannelData | undefined;
    const reactionEmoji =
      typeof telegramData?.reaction?.emoji === "string" ? telegramData.reaction.emoji : undefined;
    const replyToId =
      params.replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
    if (reactionEmoji && typeof replyToId !== "number") {
      params.runtime.error?.(danger("Telegram reaction requires a reply target"));
      continue;
    }
    if (!resolvedReplyText && !hasMedia && !reactionEmoji) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }

    const rawContent = resolvedReplyText;
    const spokenHookContent =
      !rawContent && reply.audioAsVoice === true && reply.spokenText?.trim()
        ? reply.spokenText
        : undefined;
    const hookContent = spokenHookContent ?? rawContent;
    // #41966: build latch from pre-hook plan facts so message_sending fence
    // flattening that retains literal MEDIA: still reports the diagnostic.
    const fencedMediaWarnPreHook = createDirectAcceptedFencedMediaWarnLatch({
      payload: reply,
      cfg: params.cfg,
      surface: "telegram",
    });
    const replyQuote = resolveReplyQuoteForSend({
      replyToId,
      replyQuoteByMessageId: params.replyQuoteByMessageId,
      replyQuoteMessageId: params.replyQuoteMessageId,
      replyQuoteText: params.replyQuoteText,
      replyQuotePosition: params.replyQuotePosition,
      replyQuoteEntities: params.replyQuoteEntities,
    });
    if (hasMessageSendingHooks) {
      const hookResult = await hookRunner?.runMessageSending(
        {
          to: params.chatId,
          content: hookContent,
          replyToId,
          threadId: params.thread?.id,
          metadata: {
            channel: "telegram",
            mediaUrls: mediaList,
            threadId: params.thread?.id,
          },
        },
        {
          channelId: "telegram",
          accountId: params.accountId,
          conversationId: params.chatId,
        },
      );
      if (hookResult?.cancel) {
        continue;
      }
      if (typeof hookResult?.content === "string" && hookResult.content !== hookContent) {
        // Hook-mutated content is not a projection of the tagged transcript.
        // Detach before recording the concrete Telegram send.
        progress.promptContext?.detach();
        reply = spokenHookContent
          ? { ...reply, spokenText: hookResult.content }
          : { ...reply, text: hookResult.content };
      }
    }

    let contentForSentHook =
      reply.text || (reply.audioAsVoice === true ? resolveVoiceFallbackText(reply) : "") || "";

    // #41966: Telegram Bot API direct path does not use deliverTextOrMediaReply.
    // Latch uses pre-hook parser facts; only after accepted visible Bot API sends.
    const fencedMediaWarn = fencedMediaWarnPreHook;
    const onAcceptedVisibleText = (plainText: string) => {
      fencedMediaWarn.afterAcceptedVisibleText(plainText);
    };

    try {
      const deliveredCountBeforeReply = progress.deliveredCount;
      const replyMarkup = buildInlineKeyboard(
        resolveTelegramInlineButtons({
          buttons: telegramData?.buttons,
          presentation,
          interactive,
        }),
      );
      let firstDeliveredMessageId: number | undefined;
      if (reactionEmoji && typeof replyToId === "number") {
        await params.onPlatformSendDispatch?.();
        const reactionResult = await reactMessageTelegram(params.chatId, replyToId, reactionEmoji, {
          cfg: params.cfg ?? { channels: { telegram: { botToken: params.token } } },
          token: params.token,
          accountId: params.accountId,
          api: params.bot.api,
          verbose: false,
        });
        if (reactionResult.ok) {
          progress.hasDelivered = true;
          progress.deliveredCount += 1;
        } else {
          params.runtime.error?.(danger(reactionResult.warning));
          continue;
        }
      }
      if (mediaList.length === 0 && resolvedReplyText) {
        firstDeliveredMessageId = await deliverTextReply({
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          chunkText,
          text: reply.text || "",
          replyMarkup,
          replyQuoteMessageId: replyQuote.messageId,
          replyQuoteText: replyQuote.text,
          replyQuotePosition: replyQuote.position,
          replyQuoteEntities: replyQuote.entities,
          richMessages: params.richMessages,
          tableMode: params.tableMode,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyToId,
          replyToMode: params.replyToMode,
          progress,
          recordMessageId,
          onPlatformSendDispatch: params.onPlatformSendDispatch,
          onAcceptedVisibleText,
        });
      } else if (mediaList.length > 0) {
        const mediaDelivery = await deliverMediaReply({
          reply,
          mediaList,
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          tableMode: params.tableMode,
          richMessages: params.richMessages,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaMaxBytes: params.mediaMaxBytes,
          chunkText,
          mediaLoader,
          onVoiceRecording: params.onVoiceRecording,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyQuoteMessageId: replyQuote.messageId,
          replyQuoteText: replyQuote.text,
          replyQuotePosition: replyQuote.position,
          replyQuoteEntities: replyQuote.entities,
          replyMarkup,
          replyToId,
          replyToMode: params.replyToMode,
          progress,
          recordMessageId,
          onPlatformSendDispatch: params.onPlatformSendDispatch,
          onAcceptedVisibleText,
          ...(params.textMode ? { textMode: params.textMode } : {}),
        });
        firstDeliveredMessageId = mediaDelivery.firstDeliveredMessageId;
        if (mediaDelivery.visibleFallbackText !== undefined) {
          contentForSentHook = mediaDelivery.visibleFallbackText;
        }
      }
      await maybePinFirstDeliveredMessage({
        pin: reply.delivery?.pin,
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        firstDeliveredMessageId,
      });

      if (progress.deliveredCount > deliveredCountBeforeReply && transcriptMirror) {
        deliveredContents.push({ text: contentForSentHook, mediaUrls: mediaList });
      }

      emitMessageSentHooks({
        hookRunner,
        enabled: hasMessageSentHooks,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        chatId: params.chatId,
        accountId: params.accountId,
        content: contentForSentHook,
        success: progress.deliveredCount > deliveredCountBeforeReply,
        messageId: firstDeliveredMessageId,
        isGroup: params.mirrorIsGroup,
        groupId: params.mirrorGroupId,
      });
    } catch (error) {
      emitMessageSentHooks({
        hookRunner,
        enabled: hasMessageSentHooks,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        chatId: params.chatId,
        accountId: params.accountId,
        content: contentForSentHook,
        success: false,
        error: formatErrorMessage(error),
        isGroup: params.mirrorIsGroup,
        groupId: params.mirrorGroupId,
      });
      throw error;
    }
  }

  if (progress.hasDelivered && transcriptMirror) {
    const text = deliveredContents
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n\n");
    const mediaUrls = deliveredContents.flatMap((content) => content.mediaUrls);
    if (text || mediaUrls.length > 0) {
      try {
        await transcriptMirror({
          text: text || undefined,
          mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        });
      } catch (mirrorErr) {
        logVerbose(`telegram transcriptMirror failed: ${formatErrorMessage(mirrorErr)}`);
      }
    }
  }

  return { delivered: progress.hasDelivered };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
