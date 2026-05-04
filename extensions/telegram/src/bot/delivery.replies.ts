import { type Bot, GrammyError, InputFile } from "grammy";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-types";
import { fireAndForgetHook } from "openclaw/plugin-sdk/hook-runtime";
import { createInternalHookEvent, triggerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import type { ReplyPayloadDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import {
  buildOutboundMediaLoadOptions,
  isGifMedia,
  kindFromMime,
  probeVideoDimensions,
} from "openclaw/plugin-sdk/media-runtime";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/outbound-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "../button-types.js";
import { splitTelegramCaption } from "../caption.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml,
} from "../format.js";
import { resolveTelegramInteractiveTextFallback } from "../interactive-fallback.js";
import { buildInlineKeyboard } from "../send.js";
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
const silentReplyLogger = createSubsystemLogger("telegram/silent-reply");

type DeliveryProgress = ReplyThreadDeliveryProgress & {
  deliveredCount: number;
};

type TelegramReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
};

type TelegramReplyQuoteForSend = {
  messageId?: number;
  text?: string;
  position?: number;
  entities?: unknown[];
};

type ChunkTextFn = (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;

function buildChunkTextResolver(params: {
  textLimit: number;
  chunkMode: ChunkMode;
  tableMode?: MarkdownTableMode;
}): ChunkTextFn {
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
    return chunks;
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
  replyText: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteMessageId?: number;
  replyQuoteText?: string;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
  linkPreview?: boolean;
  silent?: boolean;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  const chunks = filterEmptyTelegramTextChunks(params.chunkText(params.replyText));
  await sendChunkedTelegramReplyText({
    chunks,
    progress: params.progress,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    replyMarkup: params.replyMarkup,
    replyQuoteText: params.replyQuoteText,
    markDelivered,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup, replyQuoteText }) => {
      const messageId = await sendTelegramText(
        params.bot,
        params.chatId,
        chunk.html,
        params.runtime,
        {
          replyToMessageId,
          replyQuoteMessageId: params.replyQuoteMessageId,
          replyQuoteText,
          replyQuotePosition: params.replyQuotePosition,
          replyQuoteEntities: params.replyQuoteEntities,
          thread: params.thread,
          textMode: "html",
          plainText: chunk.text,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyMarkup,
        },
      );
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = messageId;
      }
    },
  });
  return firstDeliveredMessageId;
}

async function sendPendingFollowUpText(params: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  chunkText: ChunkTextFn;
  text: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  linkPreview?: boolean;
  silent?: boolean;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<void> {
  const chunks = filterEmptyTelegramTextChunks(params.chunkText(params.text));
  await sendChunkedTelegramReplyText({
    chunks,
    progress: params.progress,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    replyMarkup: params.replyMarkup,
    markDelivered,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup }) => {
      await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
        replyToMessageId,
        thread: params.thread,
        textMode: "html",
        plainText: chunk.text,
        linkPreview: params.linkPreview,
        silent: params.silent,
        replyMarkup,
      });
    },
  });
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

async function sendTelegramVoiceFallbackText(opts: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  text: string;
  chunkText: (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;
  replyToId?: number;
  replyQuoteMessageId?: number;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
  thread?: TelegramThreadSpec | null;
  linkPreview?: boolean;
  silent?: boolean;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  const chunks = filterEmptyTelegramTextChunks(opts.chunkText(opts.text));
  let appliedReplyTo = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    // Only apply reply reference, quote text, and buttons to the first chunk.
    const replyToForChunk = !appliedReplyTo ? opts.replyToId : undefined;
    const applyQuoteForChunk = !appliedReplyTo;
    const messageId = await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
      replyToMessageId: replyToForChunk,
      replyQuoteMessageId: applyQuoteForChunk ? opts.replyQuoteMessageId : undefined,
      replyQuoteText: applyQuoteForChunk ? opts.replyQuoteText : undefined,
      replyQuotePosition: applyQuoteForChunk ? opts.replyQuotePosition : undefined,
      replyQuoteEntities: applyQuoteForChunk ? opts.replyQuoteEntities : undefined,
      thread: opts.thread,
      textMode: "html",
      plainText: chunk.text,
      linkPreview: opts.linkPreview,
      silent: opts.silent,
      replyMarkup: !appliedReplyTo ? opts.replyMarkup : undefined,
    });
    if (firstDeliveredMessageId == null) {
      firstDeliveredMessageId = messageId;
    }
    if (replyToForChunk) {
      appliedReplyTo = true;
    }
  }
  return firstDeliveredMessageId;
}

async function deliverMediaReply(params: {
  reply: ReplyPayload;
  mediaList: string[];
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  mediaLocalRoots?: readonly string[];
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
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  let first = true;
  let pendingFollowUpText: string | undefined;
  for (const mediaUrl of params.mediaList) {
    const isFirstMedia = first;
    const media = await params.mediaLoader(
      mediaUrl,
      buildOutboundMediaLoadOptions({ mediaLocalRoots: params.mediaLocalRoots }),
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
      ? renderTelegramHtmlText(caption, { tableMode: params.tableMode })
      : undefined;
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
      const result = await sendTelegramWithThreadFallback({
        operation: "sendAnimation",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendAnimation(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "image") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendPhoto",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendPhoto(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "video") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendVideo",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendVideo(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
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
          const result = await sendTelegramWithThreadFallback({
            operation: "sendVoice",
            runtime: params.runtime,
            thread: params.thread,
            requestParams,
            shouldLog,
            send: (effectiveParams) =>
              params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams }),
          });
          if (firstDeliveredMessageId == null) {
            firstDeliveredMessageId = result.message_id;
          }
          markDelivered(params.progress);
        };
        await params.onVoiceRecording?.();
        try {
          await sendVoiceMedia(mediaParams, (err) => !isVoiceMessagesForbidden(err));
        } catch (voiceErr) {
          if (isVoiceMessagesForbidden(voiceErr)) {
            const fallbackText = params.reply.text;
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
            const fallbackMessageId = await sendTelegramVoiceFallbackText({
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
              linkPreview: params.linkPreview,
              silent: params.silent,
              replyMarkup: params.replyMarkup,
              replyQuoteText: params.replyQuoteText,
            });
            if (firstDeliveredMessageId == null) {
              firstDeliveredMessageId = fallbackMessageId;
            }
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
            const fallbackText = params.reply.text;
            if (fallbackText?.trim()) {
              await sendTelegramVoiceFallbackText({
                bot: params.bot,
                chatId: params.chatId,
                runtime: params.runtime,
                text: fallbackText,
                chunkText: params.chunkText,
                replyToId: undefined,
                thread: params.thread,
                linkPreview: params.linkPreview,
                silent: params.silent,
                replyMarkup: params.replyMarkup,
              });
            }
            markReplyApplied(params.progress, replyToMessageId);
            continue;
          }
          throw voiceErr;
        }
      } else {
        const result = await sendTelegramWithThreadFallback({
          operation: "sendAudio",
          runtime: params.runtime,
          thread: params.thread,
          requestParams: mediaParams,
          send: (effectiveParams) =>
            params.bot.api.sendAudio(params.chatId, file, { ...effectiveParams }),
        });
        if (firstDeliveredMessageId == null) {
          firstDeliveredMessageId = result.message_id;
        }
        markDelivered(params.progress);
      }
    } else {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendDocument",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) =>
          params.bot.api.sendDocument(params.chatId, file, { ...effectiveParams }),
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    }
    markReplyApplied(params.progress, replyToMessageId);
    if (pendingFollowUpText && isFirstMedia) {
      await sendPendingFollowUpText({
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        thread: params.thread,
        chunkText: params.chunkText,
        text: pendingFollowUpText,
        replyMarkup: params.replyMarkup,
        linkPreview: params.linkPreview,
        silent: params.silent,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        progress: params.progress,
      });
      pendingFollowUpText = undefined;
    }
  }
  return firstDeliveredMessageId;
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
  cfg?: import("openclaw/plugin-sdk/config-types").OpenClawConfig;
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
  replyToMode: ReplyToMode;
  textLimit: number;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
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
}): Promise<{ delivered: boolean }> {
  const progress: DeliveryProgress = {
    hasReplied: false,
    hasDelivered: false,
    deliveredCount: 0,
  };
  const mediaLoader = params.mediaLoader ?? loadWebMedia;
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const chunkText = buildChunkTextResolver({
    textLimit: params.textLimit,
    chunkMode: params.chunkMode ?? "length",
    tableMode: params.tableMode,
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
  const originalExactSilentCount = candidateReplies.filter(
    (reply) => typeof reply.text === "string" && reply.text.trim().toUpperCase() === "NO_REPLY",
  ).length;
  if (originalExactSilentCount > 0) {
    silentReplyLogger.debug("telegram delivery normalized NO_REPLY candidates", {
      hasSessionKey: Boolean(params.sessionKeyForInternalHooks),
      hasChatId: params.chatId.length > 0,
      originalCount: candidateReplies.length,
      normalizedCount: normalizedReplies.length,
      originalExactSilentCount,
    });
  }
  for (const originalReply of normalizedReplies) {
    let reply = originalReply;
    const mediaList = reply?.mediaUrls?.length
      ? reply.mediaUrls
      : reply?.mediaUrl
        ? [reply.mediaUrl]
        : [];
    const hasMedia = mediaList.length > 0;
    const resolvedReplyText =
      resolveTelegramInteractiveTextFallback({
        text: reply?.text,
        interactive: reply?.interactive,
      }) ??
      reply?.text ??
      "";
    if (reply && resolvedReplyText !== (reply.text ?? "")) {
      reply = { ...reply, text: resolvedReplyText };
    }
    if (!resolvedReplyText && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }

    const rawContent = resolvedReplyText;
    const replyToId =
      params.replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
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
          content: rawContent,
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
      if (typeof hookResult?.content === "string" && hookResult.content !== rawContent) {
        reply = { ...reply, text: hookResult.content };
      }
    }

    const contentForSentHook = reply.text || "";

    try {
      const deliveredCountBeforeReply = progress.deliveredCount;
      const telegramData = reply.channelData?.telegram as TelegramReplyChannelData | undefined;
      const replyMarkup = buildInlineKeyboard(
        resolveTelegramInlineButtons({
          buttons: telegramData?.buttons,
          interactive: reply.interactive,
        }),
      );
      let firstDeliveredMessageId: number | undefined;
      if (mediaList.length === 0) {
        firstDeliveredMessageId = await deliverTextReply({
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          chunkText,
          replyText: reply.text || "",
          replyMarkup,
          replyQuoteMessageId: replyQuote.messageId,
          replyQuoteText: replyQuote.text,
          replyQuotePosition: replyQuote.position,
          replyQuoteEntities: replyQuote.entities,
          linkPreview: params.linkPreview,
          silent: params.silent,
          replyToId,
          replyToMode: params.replyToMode,
          progress,
        });
      } else {
        firstDeliveredMessageId = await deliverMediaReply({
          reply,
          mediaList,
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          tableMode: params.tableMode,
          mediaLocalRoots: params.mediaLocalRoots,
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
        });
      }
      await maybePinFirstDeliveredMessage({
        pin: reply.delivery?.pin,
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        firstDeliveredMessageId,
      });

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

  return { delivered: progress.hasDelivered };
}
