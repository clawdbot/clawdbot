// Telegram plugin module implements delivery.replies behavior.
import { type Bot, GrammyError, InputFile } from "grammy";
import type { Message } from "grammy/types";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/channel-outbound";
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
  isGifMedia,
  kindFromMime,
  probeVideoDimensions,
} from "openclaw/plugin-sdk/media-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "../button-types.js";
import { splitTelegramCaption } from "../caption.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
  wrapFileReferencesInHtml,
} from "../format.js";
import { resolveTelegramInteractiveTextFallback } from "../interactive-fallback.js";
import type { TelegramPromptContextProjectionSequence } from "../prompt-context-projection.js";
import { splitTelegramRichMessageTextChunks, TELEGRAM_RICH_TEXT_LIMIT } from "../rich-message.js";
import { isTelegramHtmlParseError } from "../rich-plain-fallback.js";
import { buildInlineKeyboard, reactMessageTelegram } from "../send.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import {
  buildTelegramSendParams,
  sendTelegramText,
  sendTelegramWithThreadFallback,
} from "./delivery.send.js";
import { resolveTelegramReplyId, type TelegramThreadSpec } from "./helpers.js";
import type { TelegramNativeQuoteCandidateByMessageId } from "./native-quote.js";
import {
  markReplyApplied,
  resolveReplyToForSend,
  sendChunkedTelegramReplyText,
  type DeliveryProgress as ReplyThreadDeliveryProgress,
} from "./reply-threading.js";

const VOICE_FORBIDDEN_MARKER = "VOICE_MESSAGES_FORBIDDEN";
const CAPTION_TOO_LONG_RE = /caption is too long/i;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;

type DeliveryProgress = ReplyThreadDeliveryProgress & {
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

type TelegramDeliveryTextChunk = {
  text: string;
  plainText: string;
  textMode: "html";
};

type ChunkTextFn = (markdown: string) => TelegramDeliveryTextChunk[];

function buildChunkTextResolver(params: {
  textLimit: number;
  chunkMode: ChunkMode;
  tableMode?: MarkdownTableMode;
  richMessages?: boolean;
  skipEntityDetection?: boolean;
  textMode?: "html";
}): ChunkTextFn {
  if (params.richMessages === true) {
    return (text: string) =>
      splitTelegramRichMessageTextChunks({
        text,
        textLimit: Math.min(params.textLimit, TELEGRAM_RICH_TEXT_LIMIT),
        textMode: params.textMode ?? "markdown",
        chunkMode: params.chunkMode,
        tableMode: params.tableMode,
        skipEntityDetection: params.skipEntityDetection,
      });
  }
  if (params.textMode === "html") {
    return (html: string) =>
      splitTelegramHtmlChunks(html, params.textLimit).map((text) => ({
        text,
        plainText: telegramHtmlToPlainTextFallback(text),
        textMode: "html" as const,
      }));
  }
  return (markdown: string) => {
    const markdownChunks =
      params.chunkMode === "newline"
        ? chunkMarkdownTextWithMode(markdown, params.textLimit, params.chunkMode)
        : [markdown];
    const chunks: ReturnType<typeof markdownToTelegramChunks> = [];
    for (const chunk of markdownChunks) {
      const nested = markdownToTelegramChunks(chunk, params.textLimit, {
        tableMode: params.tableMode,
      });
      if (!nested.length && chunk) {
        chunks.push({
          html: wrapFileReferencesInHtml(
            markdownToTelegramHtml(chunk, { tableMode: params.tableMode, wrapFileRefs: false }),
          ),
          text: chunk,
        });
        continue;
      }
      chunks.push(...nested);
    }
    return chunks.map((chunk) => ({
      text: chunk.html,
      plainText: chunk.text,
      textMode: "html" as const,
    }));
  };
}

function markDelivered(progress: DeliveryProgress): void {
  progress.hasDelivered = true;
  progress.deliveredCount += 1;
}

function filterEmptyTelegramTextChunks<T extends { text: string }>(chunks: readonly T[]): T[] {
  // Telegram rejects whitespace-only text payloads; drop them before sendMessage so
  // hook-mutated or model-emitted empty replies become a no-op instead of a 400.
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
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
  quoteOnlyOnFirstChunk?: boolean;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  const chunks = filterEmptyTelegramTextChunks(params.chunkText(params.text));
  await sendChunkedTelegramReplyText({
    chunks,
    progress: params.progress,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    replyMarkup: params.replyMarkup,
    replyQuoteText: params.replyQuoteText,
    quoteOnlyOnFirstChunk: params.quoteOnlyOnFirstChunk,
    markDelivered,
    sendChunk: async ({ chunk, isFirstChunk, replyToMessageId, replyMarkup, replyQuoteText }) => {
      const includeQuoteMetadata = params.quoteOnlyOnFirstChunk !== true || isFirstChunk;
      const messageId = await sendTelegramText(
        params.bot,
        params.chatId,
        chunk.text,
        params.runtime,
        {
          replyToMessageId,
          replyQuoteMessageId: includeQuoteMetadata ? params.replyQuoteMessageId : undefined,
          replyQuoteText,
          replyQuotePosition: includeQuoteMetadata ? params.replyQuotePosition : undefined,
          replyQuoteEntities: includeQuoteMetadata ? params.replyQuoteEntities : undefined,
          thread: params.thread,
          textMode: chunk.textMode,
          plainText: chunk.plainText,
          richMessages: params.richMessages,
          linkPreview: params.linkPreview,
          tableMode: params.tableMode,
          silent: params.silent,
          replyMarkup,
        },
      );
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = messageId;
      }
      await params.progress.promptContext?.accept({ messageId, text: chunk.plainText });
    },
  });
  return firstDeliveredMessageId;
}

function isVoiceMessagesForbidden(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return err.description.includes(VOICE_FORBIDDEN_MARKER);
  }
  return formatErrorMessage(err).includes(VOICE_FORBIDDEN_MARKER);
}

function isCaptionTooLong(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return CAPTION_TOO_LONG_RE.test(err.description);
  }
  return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
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

function buildPlainCaptionParams(
  mediaParams: Record<string, unknown>,
  plainCaption: string,
): Record<string, unknown> {
  const nextParams: Record<string, unknown> = { ...mediaParams, caption: plainCaption };
  delete nextParams.parse_mode;
  return nextParams;
}

async function sendTelegramCaptionedMediaWithFallback<T>(params: {
  operation: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  requestParams: Record<string, unknown>;
  plainCaption?: string;
  shouldLog?: (err: unknown) => boolean;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
}): Promise<T> {
  const sendMedia = (
    requestParams: Record<string, unknown>,
    shouldLog?: (err: unknown) => boolean,
  ) =>
    sendTelegramWithThreadFallback({
      operation: params.operation,
      runtime: params.runtime,
      thread: params.thread,
      requestParams,
      ...(shouldLog ? { shouldLog } : {}),
      send: params.send,
    });
  if (!params.plainCaption) {
    return await sendMedia(params.requestParams);
  }
  try {
    return await sendMedia(
      params.requestParams,
      (err: unknown) =>
        !isTelegramHtmlParseError(err) && (params.shouldLog ? params.shouldLog(err) : true),
    );
  } catch (err) {
    if (!isTelegramHtmlParseError(err)) {
      throw err;
    }
    // Caption fallback mirrors text sends: Telegram HTML parse failures retry
    // once with plain caption so media replies are not dropped.
    logVerbose(
      `telegram ${params.operation} caption HTML rejected; retrying as plain caption: ${formatErrorMessage(
        err,
      )}`,
    );
    return await sendMedia(buildPlainCaptionParams(params.requestParams, params.plainCaption));
  }
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
  textMode?: "html";
}): Promise<{ firstDeliveredMessageId?: number; visibleFallbackText?: string }> {
  let firstDeliveredMessageId: number | undefined;
  let visibleFallbackText: string | undefined;
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
    operation: string;
    requestParams: Record<string, unknown>;
    plainCaption?: string;
    text?: string;
    shouldLog?: (err: unknown) => boolean;
    send: (effectiveParams: Record<string, unknown>) => Promise<Message>;
  }) => {
    const message = await sendTelegramCaptionedMediaWithFallback({
      ...options,
      runtime: params.runtime,
      thread: params.thread,
    });
    firstDeliveredMessageId ??= message.message_id;
    await recordPromptContextMessage(message, options.text);
    markDelivered(params.progress);
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
    const kind = kindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
    const file = new InputFile(media.buffer, fileName);
    const { caption, followUpText } = splitTelegramCaption(
      isFirstMedia ? (params.reply.text ?? undefined) : undefined,
    );
    const htmlCaption = caption
      ? params.textMode === "html"
        ? caption
        : renderTelegramHtmlText(caption, { tableMode: params.tableMode })
      : undefined;
    const plainCaption =
      caption && params.textMode === "html" ? telegramHtmlToPlainTextFallback(caption) : caption;
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
    const videoDimensions = kind === "video" ? await probeVideoDimensions(media.buffer) : undefined;
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
    if (isGif) {
      await deliverAcceptedMedia({
        operation: "sendAnimation",
        requestParams: mediaParams,
        plainCaption,
        text: plainCaption,
        send: (effectiveParams) =>
          params.bot.api.sendAnimation(params.chatId, file, { ...effectiveParams }),
      });
    } else if (kind === "image") {
      await deliverAcceptedMedia({
        operation: "sendPhoto",
        requestParams: mediaParams,
        plainCaption,
        text: plainCaption,
        send: (effectiveParams) =>
          params.bot.api.sendPhoto(params.chatId, file, { ...effectiveParams }),
      });
    } else if (kind === "video") {
      await deliverAcceptedMedia({
        operation: "sendVideo",
        requestParams: mediaParams,
        plainCaption,
        text: plainCaption,
        send: (effectiveParams) =>
          params.bot.api.sendVideo(params.chatId, file, { ...effectiveParams }),
      });
    } else if (kind === "audio") {
      const { useVoice } = resolveTelegramVoiceSend({
        wantsVoice: params.reply.audioAsVoice === true,
        contentType: media.contentType,
        fileName,
        logFallback: logVerbose,
      });
      if (useVoice) {
        const sendVoiceMedia = async (
          requestParams: typeof mediaParams,
          shouldLog?: (err: unknown) => boolean,
        ) => {
          const hasCaption = typeof requestParams.caption === "string";
          await deliverAcceptedMedia({
            operation: "sendVoice",
            requestParams,
            plainCaption: hasCaption ? plainCaption : undefined,
            text: hasCaption ? plainCaption : undefined,
            shouldLog,
            send: (effectiveParams) =>
              params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams }),
          });
        };
        await params.onVoiceRecording?.();
        try {
          await sendVoiceMedia(mediaParams, (err) => !isVoiceMessagesForbidden(err));
        } catch (voiceErr) {
          if (isVoiceMessagesForbidden(voiceErr)) {
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
            const fallbackMessageId = await deliverTextReply({
              bot: params.bot,
              chatId: params.chatId,
              runtime: params.runtime,
              text: fallbackText,
              chunkText: params.chunkText,
              replyToId: voiceFallbackReplyTo,
              replyQuoteMessageId: params.replyQuoteMessageId,
              replyQuotePosition: params.replyQuotePosition,
              replyQuoteEntities: params.replyQuoteEntities,
              thread: params.thread,
              richMessages: params.richMessages,
              tableMode: params.tableMode,
              linkPreview: params.linkPreview,
              silent: params.silent,
              replyMarkup: params.replyMarkup,
              replyQuoteText: params.replyQuoteText,
              replyToMode: params.replyToMode,
              progress: createVoiceFallbackProgress(),
              quoteOnlyOnFirstChunk: true,
            });
            if (firstDeliveredMessageId == null) {
              firstDeliveredMessageId = fallbackMessageId;
            }
            visibleFallbackText = fallbackText;
            markReplyApplied(params.progress, voiceFallbackReplyTo);
            markDelivered(params.progress);
            continue;
          }
          if (isCaptionTooLong(voiceErr)) {
            logVerbose(
              "telegram sendVoice caption too long; resending voice without caption + text separately",
            );
            const noCaptionParams = { ...mediaParams };
            delete noCaptionParams.caption;
            delete noCaptionParams.parse_mode;
            await sendVoiceMedia(noCaptionParams);
            const fallbackText = resolveVoiceFallbackText(params.reply);
            if (fallbackText?.trim()) {
              await deliverTextReply({
                bot: params.bot,
                chatId: params.chatId,
                runtime: params.runtime,
                text: fallbackText,
                chunkText: params.chunkText,
                replyToId: undefined,
                thread: params.thread,
                richMessages: params.richMessages,
                tableMode: params.tableMode,
                linkPreview: params.linkPreview,
                silent: params.silent,
                replyMarkup: params.replyMarkup,
                replyToMode: "first",
                progress: createVoiceFallbackProgress(),
                quoteOnlyOnFirstChunk: true,
              });
              visibleFallbackText = fallbackText;
            }
            markReplyApplied(params.progress, replyToMessageId);
            continue;
          }
          throw voiceErr;
        }
      } else {
        await deliverAcceptedMedia({
          operation: "sendAudio",
          requestParams: mediaParams,
          plainCaption,
          text: plainCaption,
          send: (effectiveParams) =>
            params.bot.api.sendAudio(params.chatId, file, { ...effectiveParams }),
        });
      }
    } else {
      await deliverAcceptedMedia({
        operation: "sendDocument",
        requestParams: mediaParams,
        plainCaption,
        text: plainCaption,
        send: (effectiveParams) =>
          params.bot.api.sendDocument(params.chatId, file, { ...effectiveParams }),
      });
    }
    markReplyApplied(params.progress, replyToMessageId);
    if (pendingFollowUpText && isFirstMedia) {
      await deliverTextReply({
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
      });
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

export function emitInternalMessageSentHook(params: EmitMessageSentHookParams): void {
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
  /** Opt into Telegram Bot API 10.1 rich text delivery. */
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
}): Promise<{
  delivered: boolean;
}> {
  const progress: DeliveryProgress = {
    hasReplied: false,
    hasDelivered: false,
    deliveredCount: 0,
    ...(params.promptContextSequence ? { promptContext: params.promptContextSequence } : {}),
  };
  const mediaLoader = params.mediaLoader ?? loadWebMedia;
  const transcriptMirror = params.transcriptMirror;
  const deliveredContents: Array<{ text: string; mediaUrls: string[] }> = [];
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const chunkText = buildChunkTextResolver({
    textLimit:
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
    let reply = originalReply;
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
          ...(params.textMode ? { textMode: params.textMode } : {}),
        });
        firstDeliveredMessageId = mediaDelivery.firstDeliveredMessageId;
        if (mediaDelivery.visibleFallbackText) {
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
