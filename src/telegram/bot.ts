// @ts-nocheck
import { Buffer } from "node:buffer";

import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions, Context, Message } from "grammy";
import { Bot, InputFile, webhookCallback } from "grammy";

import { chunkText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { isAudio, transcribeInboundAudio } from "../auto-reply/transcription.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import {
  parseDeepResearchCommand,
  normalizeDeepResearchTopic,
  createExecuteButton,
  createRetryButton,
  parseCallbackData,
  CALLBACK_PREFIX,
  CallbackActions,
  executeDeepResearch,
  deliverResults,
  truncateForTelegram,
  messages,
  generateGapQuestions,
  type DeepResearchProgressStage,
} from "../deep-research/index.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, isVerbose, logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { categorizeIntent } from "../infra/intent-categorizer.js";
import { getChildLogger } from "../logging.js";
import { mediaKindFromMime } from "../media/constants.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";
import { startLivenessProbe, type LivenessProbeOptions } from "./liveness-probe.js";
import { messages as webSearchMessages } from "../web-search/messages.js";
import { executeWebSearch } from "../web-search/executor.js";
import {
  createTTSButton,
  createTTSProgressButton,
  parseTTSCallbackData,
  TTS_CALLBACK_PREFIX,
  type TTSProgressStage,
} from "../tts/button.js";
import { isTTSEnabled, synthesize } from "../tts/provider.js";
import { formatTelegramMessage } from "./formatter.js";

const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;
const deepResearchInFlight = new Set<number>();
const webSearchInFlight = new Set<number>();

// TTS in-flight tracking with TTL (5 minutes)
const ttsInFlight = new Map<string, number>();
const TTS_IN_FLIGHT_TTL_MS = 5 * 60 * 1000;
const TTS_CLEANUP_INTERVAL_MS = 60 * 1000; // Clean every minute

// Periodic cleanup of expired TTS entries
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, timestamp] of ttsInFlight.entries()) {
    if (now - timestamp > TTS_IN_FLIGHT_TTL_MS) {
      ttsInFlight.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logVerbose(`[tts] Cleaned up ${cleaned} expired in-flight entries`);
  }
}, TTS_CLEANUP_INTERVAL_MS);
const CATEGORY_CONFIDENCE_THRESHOLD = 0.7;
const CATEGORY_MIN_WORDS = 2;
const CATEGORY_MIN_CHARS = 6;
const AUDIO_STATUS_MESSAGE = "○ Голосовое получено. Распознаю...";
const AUDIO_STATUS_DONE = "● Готово";

type StatusMessage = {
  chatId: number;
  messageId: number;
};

type TelegramMessage = Message.CommonMessage;

type TelegramContext = {
  message: TelegramMessage;
  me?: { username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

type ReplyMarkup = Parameters<Context["api"]["editMessageText"]>[3]["reply_markup"];

export type TelegramBotOptions = {
  token: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  proxyFetch?: typeof fetch;
  livenessProbe?: Omit<LivenessProbeOptions, "bot"> | boolean;
};

export function createTelegramBot(opts: TelegramBotOptions) {
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const client: ApiClientOptions | undefined = opts.proxyFetch
    ? { fetch: opts.proxyFetch as unknown as ApiClientOptions["fetch"] }
    : undefined;

  const bot = new Bot(opts.token, { client });
  bot.api.config.use(apiThrottler());

  const cfg = loadConfig();
  const requireMention =
    opts.requireMention ?? cfg.telegram?.requireMention ?? true;
  const allowFrom = opts.allowFrom ?? cfg.telegram?.allowFrom;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.telegram?.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });

  bot.on("message", async (ctx) => {
    let progressStatus: StatusMessage | null = null;
    try {
      const msg = ctx.message;
      if (!msg) return;
      const chatId = msg.chat.id;
      const isGroup =
        msg.chat.type === "group" || msg.chat.type === "supergroup";

      // Instant acknowledgment at the very beginning
      try {
        let initialAck = "🤔 Думаю...";
        if (msg.photo) initialAck = "📸 Вижу фото, сейчас посмотрю...";
        else if (msg.video) initialAck = "🎥 Вижу видео, сейчас изучу...";
        else if (msg.voice || msg.audio) initialAck = "🎙️ Слушаю аудио...";
        else if (msg.document) initialAck = "📂 Вижу файл, сейчас проверю...";
        
        const status = await ctx.reply(initialAck);
        progressStatus = {
          chatId: ctx.chat?.id ?? chatId,
          messageId: status.message_id,
        };
      } catch (err) {
        logVerbose(`telegram initial ack failed: ${String(err)}`);
      }

      const sendTyping = async () => {
        try {
          await bot.api.sendChatAction(chatId, "typing");
        } catch (err) {
          logVerbose(
            `telegram typing cue failed for chat ${chatId}: ${String(err)}`,
          );
        }
      };

      // allowFrom for direct chats
      if (!isGroup && Array.isArray(allowFrom) && allowFrom.length > 0) {
        const candidate = String(chatId);
        const allowed = allowFrom.map(String);
        const allowedWithPrefix = allowFrom.map((v) => `telegram:${String(v)}`);
        const permitted =
          allowed.includes(candidate) ||
          allowedWithPrefix.includes(`telegram:${candidate}`) ||
          allowed.includes("*");
        if (!permitted) {
          logVerbose(
            `Blocked unauthorized telegram sender ${candidate} (not in allowFrom)`,
          );
          return;
        }
      }

      const botUsername = ctx.me?.username?.toLowerCase();
      if (
        isGroup &&
        requireMention &&
        botUsername &&
        !hasBotMention(msg, botUsername)
      ) {
        logger.info({ chatId, reason: "no-mention" }, "skipping group message");
        return;
      }

      const media = await resolveMedia(
        ctx,
        mediaMaxBytes,
        opts.token,
        opts.proxyFetch,
      );
      const isAudioInput =
        !msg.text &&
        !msg.caption &&
        media?.contentType &&
        isAudio(media.contentType);
      
      let transcript: string | undefined;
      if (
        isAudioInput
      ) {
        if (progressStatus) {
          await editTelegramMessage(ctx.api, progressStatus, "🎙️ Голосовое получено. Распознаю...");
        }
        const transcribed = await transcribeInboundAudio(
          cfg,
          {
            MediaPath: media.path,
            MediaUrl: media.path,
            MediaType: media.contentType,
            Surface: "telegram",
          },
          runtime,
        );
        transcript = transcribed?.text;
      }
      const messageText = (
        msg.text ??
        msg.caption ??
        transcript ??
        ""
      ).trim();
      if (
        await handleDeepResearchMessage(
          ctx,
          cfg,
          chatId,
          messageText,
          transcript,
          progressStatus,
        )
      ) {
        return;
      }

      // Check for /web command
      const webCommand = parseWebCommand(messageText, botUsername);
      if (webCommand) {
        const query = webCommand.query.trim();
        if (!query) {
          if (progressStatus) {
            await editTelegramMessage(
              ctx.api,
              progressStatus,
              webSearchMessages.error(
                "Please provide a search query after /web",
              ),
            );
          } else {
            await ctx.reply(
              webSearchMessages.error(
                "Please provide a search query after /web",
              ),
            );
          }
          return;
        }
        await runWebSearch(ctx, chatId, query, logger, progressStatus);
        return;
      }

      // Only use automatic LLM-based categorization if enabled in config
      if (
        cfg.telegram?.autoCategorize &&
        (await handleCategorizedMessage(
          ctx,
          cfg,
          chatId,
          messageText,
          transcript,
          logger,
          progressStatus,
        ))
      ) {
        return;
      }

      const replyTarget = describeReplyTarget(msg);
      const rawBody = (
        msg.text ??
        msg.caption ??
        transcript ??
        media?.placeholder ??
        ""
      ).trim();
      if (!rawBody) return;
      const replySuffix = replyTarget
        ? `\n\n[Replying to ${replyTarget.sender}]\n${replyTarget.body}\n[/Replying]`
        : "";
      const body = formatAgentEnvelope({
        surface: "Telegram",
        from: isGroup
          ? buildGroupLabel(msg, chatId)
          : buildSenderLabel(msg, chatId),
        timestamp: msg.date ? msg.date * 1000 : undefined,
        body: `${rawBody}${replySuffix}`,
      });

      const ctxPayload = {
        Body: body,
        From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
        To: `telegram:${chatId}`,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
        SenderName: buildSenderName(msg),
        Surface: "telegram",
        MessageSid: String(msg.message_id),
        ReplyToId: replyTarget?.id,
        ReplyToBody: replyTarget?.body,
        ReplyToSender: replyTarget?.sender,
        Timestamp: msg.date ? msg.date * 1000 : undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        Transcript: transcript,
      };

      if (replyTarget && isVerbose()) {
        const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
        logVerbose(
          `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
        );
      }

      if (!isGroup) {
        const sessionCfg = cfg.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "telegram",
          to: String(chatId),
        });
      }

      if (isVerbose()) {
        const preview = body.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
        );
      }

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        {
          onReplyStart: sendTyping,
          waitForFinalReply: true, // Wait for final reply instead of streaming
          // Tool streaming enabled - shows "Using tool: X..." messages
          onToolStart: async ({ name }) => {
            if (progressStatus) {
              await editTelegramMessage(
                bot.api,
                progressStatus,
                formatTelegramMessage(`○ Инструмент: *${name}*...`),
              );
            }
          },
          onToolResult: async (payload) => {
            await deliverReplies({
              replies: [payload],
              chatId: String(chatId),
              token: opts.token,
              runtime,
              bot,
              statusMessage: progressStatus,
            });
          },
          // onPartialReply will be suppressed by waitForFinalReply
        },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      if (replies.length === 0) return;

      await deliverReplies({
        replies,
        chatId: String(chatId),
        token: opts.token,
        runtime,
        bot,
        statusMessage: progressStatus,
      });
    } catch (err) {
      // Clean up in-flight sets on error (if chatId was defined)
      if (typeof chatId !== 'undefined' && webSearchInFlight.has(chatId)) {
        webSearchInFlight.delete(chatId);
      }
      runtime.error?.(danger(`Telegram handler failed: ${String(err)}`));
    }
  });

  // Deep Research and TTS button callback handler
  bot.on("callback_query:data", async (ctx, next) => {
    const handled = await handleDeepResearchCallback(ctx, runtime);
    if (!handled) {
      await handleTTSCallback(ctx, runtime);
    }
    if (next) await next();
  });

  // Start liveness probe if enabled
  if (opts.livenessProbe !== false) {
    const livenessOpts =
      typeof opts.livenessProbe === "object" ? opts.livenessProbe : {};
    startLivenessProbe({ bot, ...livenessOpts });
  }

  return bot;
}

export function createTelegramWebhookCallback(
  bot: Bot,
  path = "/telegram-webhook",
) {
  return { path, handler: webhookCallback(bot, "http") };
}

async function handleDeepResearchMessage(
  ctx: Context,
  cfg: ReturnType<typeof loadConfig>,
  chatId: number,
  messageText: string,
  transcript?: string,
  statusMessage?: StatusMessage | null,
): Promise<boolean> {
  if (cfg.deepResearch?.enabled === false) return false;

  if (!messageText) return false;

  const command = parseDeepResearchCommand(messageText);
  if (!command) {
    return false;
  }

  return handleDeepResearchTopic({
    ctx,
    cfg,
    chatId,
    topic: command.topic,
    transcript,
    source: "command",
    respondOnInvalid: true,
    statusMessage,
  });
}

async function handleDeepResearchTopic(params: {
  ctx: Context;
  cfg: ReturnType<typeof loadConfig>;
  chatId: number;
  topic: string;
  transcript?: string;
  source: "command" | "category";
  respondOnInvalid: boolean;
  statusMessage?: StatusMessage | null;
}): Promise<boolean> {
  const { ctx, cfg, chatId, topic, transcript, source, respondOnInvalid } =
    params;
  const trimmedTopic = topic.trim();

  if (!trimmedTopic) {
    if (respondOnInvalid) {
      if (params.statusMessage) {
        await editTelegramMessage(
          ctx.api,
          params.statusMessage,
          messages.invalidTopic(),
        );
      } else {
        await ctx.reply(messages.invalidTopic());
      }
      return true;
    }
    return false;
  }

  const normalized = normalizeDeepResearchTopic(trimmedTopic);
  if (!normalized) {
    if (!respondOnInvalid) return false;
    const questions = await generateGapQuestions({
      request: trimmedTopic,
      cfg,
    });
    if (questions && questions.length > 0) {
      const text = messages.gapQuestions(questions);
      if (params.statusMessage) {
        await editTelegramMessage(ctx.api, params.statusMessage, text);
      } else {
        await ctx.reply(text);
      }
    } else {
      if (params.statusMessage) {
        await editTelegramMessage(
          ctx.api,
          params.statusMessage,
          messages.invalidTopic(),
        );
      } else {
        await ctx.reply(messages.invalidTopic());
      }
    }
    return true;
  }

  const { topic: cleanedTopic, truncated } = normalized;
  const userId = ctx.from?.id;
  if (userId === undefined) {
    if (!respondOnInvalid) return false;
    if (params.statusMessage) {
      await editTelegramMessage(
        ctx.api,
        params.statusMessage,
        messages.missingUserId(),
      );
    } else {
      await ctx.reply(messages.missingUserId());
    }
    return true;
  }

  if (truncated) {
    logVerbose(
      `[deep-research] Topic truncated for ${userId} in chat ${chatId}`,
    );
  }
  const sourceLabel =
    source === "command" ? "Command received" : "Categorized request";
  logVerbose(
    `[deep-research] ${sourceLabel} from ${userId} in chat ${chatId}: "${cleanedTopic}"`,
  );

  const ackText = messages.acknowledgment(cleanedTopic, transcript);
  const replyMarkup = createExecuteButton(cleanedTopic, userId);
  if (params.statusMessage) {
    await editTelegramMessage(
      ctx.api,
      params.statusMessage,
      ackText,
      replyMarkup,
    );
  } else {
    await ctx.reply(ackText, { reply_markup: replyMarkup });
  }

  return true;
}

async function handleCategorizedMessage(
  ctx: Context,
  cfg: ReturnType<typeof loadConfig>,
  chatId: number,
  messageText: string,
  transcript: string | undefined,
  logger: ReturnType<typeof getChildLogger>,
  statusMessage?: StatusMessage | null,
): Promise<boolean> {
  if (!shouldCategorizeMessage(messageText)) {
    return false;
  }

  const result = await categorizeIntent(messageText);
  if (!result || result.confidence < CATEGORY_CONFIDENCE_THRESHOLD) {
    return false;
  }

  const category = normalizeCategory(result.category);
  if (isVerbose()) {
    logVerbose(
      `[intent] category="${result.category}" confidence=${result.confidence} timeMs=${result.timeMs ?? "n/a"}`,
    );
  }

  if (category === "deep") {
    if (cfg.deepResearch?.enabled === false) return false;
    return handleDeepResearchTopic({
      ctx,
      cfg,
      chatId,
      topic: messageText,
      transcript,
      source: "category",
      respondOnInvalid: false,
      statusMessage,
    });
  }

  if (category === "web") {
    if (cfg.webSearch?.enabled === false) return false;
    const query = messageText.trim();
    if (!query) return false;
    await runWebSearch(ctx, chatId, query, logger, statusMessage);
    return true;
  }

  return false;
}

function shouldCategorizeMessage(messageText: string): boolean {
  const trimmed = messageText.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.length < CATEGORY_MIN_CHARS) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= CATEGORY_MIN_WORDS;
}

function normalizeCategory(category: string): "deep" | "web" | null {
  const normalized = category.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "deepresearch") return "deep";
  if (normalized === "web" || normalized === "websearch" || normalized === "search") {
    return "web";
  }
  return null;
}

function parseWebCommand(
  messageText: string,
  botUsername?: string,
): { query: string } | null {
  const match =
    /^\/web(?:@([a-z0-9_]+))?(?:\s+([\s\S]+))?$/i.exec(messageText.trim());
  if (!match) return null;
  const mentioned = match[1];
  if (mentioned && botUsername && mentioned.toLowerCase() !== botUsername) {
    return null;
  }
  return { query: (match[2] ?? "").trim() };
}

async function runWebSearch(
  ctx: Context,
  chatId: number,
  query: string,
  logger: ReturnType<typeof getChildLogger>,
  statusMessage?: StatusMessage | null,
): Promise<void> {
  // Check if already searching for this chat
  if (webSearchInFlight.has(chatId)) {
    await ctx.reply(
      webSearchMessages.error(
        "Поиск уже выполняется для этого чата. Пожалуйста, подождите.",
      ),
    );
    return;
  }

  // Mark as in-flight
  webSearchInFlight.add(chatId);

  let statusChatId: number | undefined = statusMessage?.chatId;
  let statusMessageId: number | undefined = statusMessage?.messageId;

  try {
    // Send acknowledgment and store message ID for editing
    if (statusChatId && statusMessageId) {
      await editTelegramMessage(
        ctx.api,
        { chatId: statusChatId, messageId: statusMessageId },
        webSearchMessages.acknowledgment(),
      );
    } else {
      const sent = await ctx.reply(webSearchMessages.acknowledgment(), {
        parse_mode: "MarkdownV2",
      });
      statusChatId = ctx.chat?.id;
      statusMessageId = sent.message_id;
    }

    if (!statusChatId || !statusMessageId) {
      throw new Error("Failed to get message ID for status update");
    }

    // Execute search with 90s timeout for deep research
    const result = await executeWebSearch(query, { timeoutMs: 90000 });

    if (result.success && result.result) {
      // Edit the original message with result
      const resultText = webSearchMessages.resultDelivery(result.result);

      // Add TTS button if enabled
      let replyMarkup = undefined;
      if (isTTSEnabled()) {
        try {
          replyMarkup = createTTSButton(result.result.response);
        } catch (err) {
          console.warn(`[tts] Failed to create button: ${err}`);
        }
      }

      await ctx.api.editMessageText(
        statusChatId,
        statusMessageId,
        resultText,
        { parse_mode: "MarkdownV2", reply_markup: replyMarkup },
      );
    } else {
      // Edit with error
      await ctx.api.editMessageText(
        statusChatId,
        statusMessageId,
        webSearchMessages.error(result.error || "Unknown error", result.runId),
        { parse_mode: "MarkdownV2" },
      );
    }
  } catch (error) {
    logger.error({ chatId, error }, "Web search execution failed");
    // If we have a status message, try to edit it
    if (statusChatId && statusMessageId) {
      try {
        await ctx.api.editMessageText(
          statusChatId,
          statusMessageId,
          webSearchMessages.error(
            error instanceof Error ? error.message : String(error),
          ),
          { parse_mode: "MarkdownV2" },
        );
      } catch (editError) {
        // If edit fails, send new message
        await ctx.reply(
          webSearchMessages.error(
            error instanceof Error ? error.message : String(error),
          ),
          { parse_mode: "MarkdownV2" },
        );
      }
    } else {
      // No status message to edit, send new message
      await ctx.reply(
        webSearchMessages.error(
          error instanceof Error ? error.message : String(error),
        ),
        { parse_mode: "MarkdownV2" },
      );
    }
  } finally {
    // Always remove from in-flight set
    webSearchInFlight.delete(chatId);
  }
}

async function editTelegramMessage(
  api: Bot["api"],
  statusMessage: StatusMessage,
  text: string,
  replyMarkup?: ReplyMarkup,
): Promise<void> {
  const formatted = formatTelegramMessage(text);
  try {
    await api.editMessageText(statusMessage.chatId, statusMessage.messageId, formatted, {
      parse_mode: "MarkdownV2",
      reply_markup: replyMarkup,
    });
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      await api.editMessageText(statusMessage.chatId, statusMessage.messageId, formatted, {
        reply_markup: replyMarkup,
      });
      return;
    }
    throw err;
  }
}

async function handleDeepResearchCallback(
  ctx: Context,
  runtime: RuntimeEnv,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(CALLBACK_PREFIX)) {
    return false;
  }

  const parsed = parseCallbackData(data);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: messages.callbackInvalid() });
    return true;
  }

  const { action, topic, ownerId } = parsed;
  const callerId = ctx.from?.id;

  if (callerId === undefined) {
    await ctx.answerCallbackQuery({ text: messages.callbackInvalid() });
    return true;
  }

  const isPrivateChat = ctx.chat?.type === "private";
  // Allow ownerless callbacks only in private chats (legacy buttons).
  if (ownerId === undefined && !isPrivateChat) {
    await ctx.answerCallbackQuery({ text: messages.callbackInvalid() });
    return true;
  }

  if (ownerId !== undefined && ownerId !== callerId) {
    await ctx.answerCallbackQuery({ text: messages.callbackUnauthorized() });
    return true;
  }

  const effectiveOwnerId = ownerId ?? callerId;

  if (action !== CallbackActions.EXECUTE && action !== CallbackActions.RETRY) {
    await ctx.answerCallbackQuery({ text: messages.callbackInvalid() });
    return true;
  }

  if (deepResearchInFlight.has(callerId)) {
    await ctx.answerCallbackQuery({ text: messages.callbackBusy() });
    return true;
  }

  const normalized = normalizeDeepResearchTopic(topic);
  if (!normalized) {
    await ctx.answerCallbackQuery({ text: messages.callbackInvalid() });
    return true;
  }

  const normalizedTopic = normalized.topic;
  if (normalized.truncated) {
    logVerbose(
      `[deep-research] Callback topic truncated for ${callerId}: "${normalizedTopic}"`,
    );
  }

  try {
    deepResearchInFlight.add(callerId);

    await ctx.answerCallbackQuery({ text: messages.callbackAcknowledgment() });
    const statusMessage = await ctx.reply(messages.progress("starting"), {
      parse_mode: "MarkdownV2",
    });
    const statusChatId = ctx.chat?.id;
    const statusMessageId = statusMessage.message_id;
    let statusStage: DeepResearchProgressStage = "starting";
    let statusRunId: string | undefined;
    let lastStatusText = messages.progress(statusStage);

    const updateStatus = async (
      nextStage?: DeepResearchProgressStage,
      nextRunId?: string,
    ) => {
      if (!statusChatId || !statusMessageId) return;
      if (nextStage) statusStage = nextStage;
      if (nextRunId) statusRunId = nextRunId;
      const nextText = messages.progress(statusStage, statusRunId);
      if (nextText === lastStatusText) return;
      lastStatusText = nextText;
      try {
        await ctx.api.editMessageText(
          statusChatId,
          statusMessageId,
          nextText,
          { parse_mode: "MarkdownV2" },
        );
      } catch (err) {
        logVerbose(
          `[deep-research] Failed to update status message: ${String(err)}`,
        );
      }
    };

    const mapEventToStage = (
      eventName?: string,
    ): DeepResearchProgressStage | null => {
      switch (eventName) {
        case "run.start":
          return "starting";
        case "run.notice":
        case "interaction.start":
          return "working";
        case "agent_summary.start":
          return "summarizing";
        case "publish.start":
          return "publishing";
        case "run.complete":
          return "done";
        default:
          return null;
      }
    };

    logVerbose(
      `[deep-research] Starting execution for topic: "${normalizedTopic}"`,
    );
    const executeResult = await executeDeepResearch({
      topic: normalizedTopic,
      onEvent: (event) => {
        if (event.run_id) {
          void updateStatus(undefined, String(event.run_id));
        }
        const stage = mapEventToStage(
          typeof event.event === "string" ? event.event : undefined,
        );
        if (stage) {
          void updateStatus(stage);
        }
      },
    });

    const deliveryContext = {
      sendMessage: async (text: string) => {
        try {
          const formatted = formatTelegramMessage(`○ ${text}`);
          await ctx.reply(truncateForTelegram(formatted), {
            parse_mode: "MarkdownV2",
          });
        } catch {
          await ctx.reply(truncateForTelegram(text));
        }
      },
      sendError: async (text: string) => {
        const formatted = formatTelegramMessage(`✂︎ ${text}`);
        await ctx.reply(formatted, {
          parse_mode: "MarkdownV2",
          reply_markup: createRetryButton(normalizedTopic, effectiveOwnerId),
        });
      },
    };

    const success = await deliverResults(executeResult, deliveryContext);

    if (success) {
      await updateStatus("done");
      logVerbose(
        `[deep-research] Completed successfully for topic: "${normalizedTopic}"`,
      );
    } else {
      await updateStatus("failed");
      logVerbose(`[deep-research] Failed for topic: "${normalizedTopic}"`);
    }
  } catch (error) {
    runtime.error?.(
      danger(`[deep-research] Unexpected error: ${String(error)}`),
    );
    await ctx.reply(
      messages.error(
        error instanceof Error ? error.message : "Unexpected error",
      ),
      {
        reply_markup: createRetryButton(
          normalizedTopic,
          effectiveOwnerId,
        ),
      },
    );
  } finally {
    deepResearchInFlight.delete(callerId);
  }

  return true;
}

async function handleTTSCallback(
  ctx: Context,
  runtime: RuntimeEnv,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(TTS_CALLBACK_PREFIX)) {
    return false;
  }

  const textHash = parseTTSCallbackData(data);
  if (!textHash) {
    await ctx.answerCallbackQuery({ text: "Invalid TTS callback" });
    return true;
  }

  const callerId = ctx.from?.id;
  if (callerId === undefined) {
    await ctx.answerCallbackQuery({ text: "Invalid user" });
    return true;
  }

  // Check if already processing (with TTL check)
  const flightKey = `${callerId}:${textHash}`;
  const now = Date.now();
  const existingTimestamp = ttsInFlight.get(flightKey);
  if (existingTimestamp && now - existingTimestamp < TTS_IN_FLIGHT_TTL_MS) {
    await ctx.answerCallbackQuery({ text: "Уже генерирую..." });
    return true;
  }

  // Add with current timestamp
  ttsInFlight.set(flightKey, now);

  try {
    await ctx.answerCallbackQuery({ text: "Генерирую аудио..." });

    // Get original message to extract result text
    const msg = ctx.callbackQuery.message;
    if (!msg || !("text" in msg)) {
      await ctx.reply("Ошибка: не найден оригинальный результат");
      return true;
    }

    // Extract web search result text from message
    const resultText = msg.text
      .replace(/^○ Результат поиска:\n\n/, "")
      .trim();

    if (!resultText) {
      await ctx.reply("Ошибка: пустой результат");
      return true;
    }

    const chatId = ctx.chat?.id;
    const messageId = msg.message_id;

    if (!chatId || !messageId) {
      await ctx.reply("Ошибка: не получен ID чата");
      return true;
    }

    // Progress update function
    let currentStage: TTSProgressStage = 0;
    const updateProgress = async (stage: TTSProgressStage) => {
      if (stage === currentStage) return;
      currentStage = stage;
      try {
        const button = createTTSProgressButton(stage, textHash);
        await ctx.api.editMessageReplyMarkup(chatId, messageId, button);
      } catch (err) {
        console.warn(`[tts] Failed to update progress: ${err}`);
      }
    };

    // Generate audio
    const result = await synthesize(resultText, async (percentage) => {
      if (percentage >= 100) await updateProgress(4);
      else if (percentage >= 75) await updateProgress(3);
      else if (percentage >= 50) await updateProgress(2);
      else if (percentage >= 25) await updateProgress(1);
      else await updateProgress(0);
    });

    if (result.success && result.audioPath) {
      // Send audio file
      const fs = await import("node:fs");
      if (fs.existsSync(result.audioPath)) {
        const file = new InputFile(result.audioPath, "tts.mp3");

        await ctx.api.sendVoice(chatId, file, {
          caption: result.cached ? "🎙️ (из кэша)" : "🎙️",
        });
      }
      // Remove button
      await ctx.api.editMessageReplyMarkup(chatId, messageId);
    } else {
      // Show error, remove button
      await ctx.api.editMessageText(
        chatId,
        messageId,
        `✂︎ Озвучка не удалась:\n\n${result.error || "Неизвестная ошибка"}`,
      );
    }
  } finally {
    ttsInFlight.delete(flightKey);
  }

  return true;
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  statusMessage?: StatusMessage | null;
}) {
  const { replies, chatId, runtime, bot, statusMessage } = params;
  let statusEdited = false;
  for (const reply of replies) {
    if (!reply?.text && !reply?.mediaUrl && !(reply?.mediaUrls?.length ?? 0)) {
      runtime.error?.(danger("Telegram reply missing text/media"));
      continue;
    }
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    if (mediaList.length === 0) {
      const chunks = chunkText(reply.text || "", 4000);
      for (const chunk of chunks) {
        if (statusMessage && !statusEdited) {
          await editTelegramMessage(bot.api, statusMessage, chunk);
          statusEdited = true;
          continue;
        }
        await sendTelegramText(bot, chatId, chunk, runtime);
      }
      continue;
    }
    if (statusMessage && !statusEdited) {
      await editTelegramMessage(bot.api, statusMessage, AUDIO_STATUS_DONE);
      statusEdited = true;
    }
    // media with optional caption on first item
    let first = true;
    for (const mediaUrl of mediaList) {
      const media = await loadWebMedia(mediaUrl);
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const file = new InputFile(media.buffer, media.fileName ?? "file");
      const caption = first ? (reply.text ?? undefined) : undefined;
      first = false;
      if (kind === "image") {
        await bot.api.sendPhoto(chatId, file, { caption });
      } else if (kind === "video") {
        await bot.api.sendVideo(chatId, file, { caption });
      } else if (kind === "audio") {
        await bot.api.sendAudio(chatId, file, { caption });
      } else {
        await bot.api.sendDocument(chatId, file, { caption });
      }
    }
  }
  if (statusMessage && !statusEdited) {
    await editTelegramMessage(bot.api, statusMessage, AUDIO_STATUS_DONE);
  }
}

function buildSenderName(msg: TelegramMessage) {
  const name =
    [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || msg.from?.username;
  return name || undefined;
}

function buildSenderLabel(msg: TelegramMessage, chatId: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const idPart = `id:${chatId}`;
  return label ? `${label} ${idPart}` : idPart;
}

function buildGroupLabel(msg: TelegramMessage, chatId: number | string) {
  const title = msg.chat?.title;
  if (title) return `${title} id:${chatId}`;
  return `group:${chatId}`;
}

function hasBotMention(msg: TelegramMessage, botUsername: string) {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase();
  if (text.includes(`@${botUsername}`)) return true;
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type !== "mention") continue;
    const slice = (msg.text ?? msg.caption ?? "").slice(
      ent.offset,
      ent.offset + ent.length,
    );
    if (slice.toLowerCase() === `@${botUsername}`) return true;
  }
  return false;
}

async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  proxyFetch?: typeof fetch,
): Promise<{ path: string; contentType?: string; placeholder: string } | null> {
  const msg = ctx.message;
  const m =
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.document ??
    msg.audio ??
    msg.voice;
  if (!m?.file_id) return null;
  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set telegram.proxy in config");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download telegram file: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const data = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer: data,
    headerMime: res.headers.get("content-type"),
    filePath: file.file_path,
  });
  const saved = await saveMediaBuffer(data, mime, "inbound", maxBytes);
  let placeholder = "<media:document>";
  if (msg.photo) placeholder = "<media:image>";
  else if (msg.video) placeholder = "<media:video>";
  else if (msg.audio || msg.voice) placeholder = "<media:audio>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}

async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
): Promise<number | undefined> {
  const formatted = formatTelegramMessage(`○ ${text}`);
  try {
    const res = await bot.api.sendMessage(chatId, formatted, {
      parse_mode: "MarkdownV2",
    });
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      runtime.log?.(
        `telegram markdown parse failed; retrying without formatting: ${errText}`,
      );
      const res = await bot.api.sendMessage(chatId, formatted, {});
      return res.message_id;
    }
    throw err;
  }
}

function describeReplyTarget(msg: TelegramMessage) {
  const reply = msg.reply_to_message;
  if (!reply) return null;
  const replyBody = (reply.text ?? reply.caption ?? "").trim();
  let body = replyBody;
  if (!body) {
    if (reply.photo) body = "<media:image>";
    else if (reply.video) body = "<media:video>";
    else if (reply.audio || reply.voice) body = "<media:audio>";
    else if (reply.document) body = "<media:document>";
  }
  if (!body) return null;
  const sender = buildSenderName(reply);
  const senderLabel = sender ? `${sender}` : "unknown sender";
  return {
    id: reply.message_id ? String(reply.message_id) : undefined,
    sender: senderLabel,
    body,
  };
}
