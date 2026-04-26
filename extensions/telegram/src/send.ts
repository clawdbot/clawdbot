import type { ReactionType, ReactionTypeEmoji } from "@grammyjs/types";
import * as grammy from "grammy";
import { type ApiClientOptions, Bot, HttpError } from "grammy";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import { formatUncaughtError } from "openclaw/plugin-sdk/error-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { createTelegramRetryRunner, type RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString, redactSensitiveText } from "openclaw/plugin-sdk/text-runtime";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { buildTypingThreadParams } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { splitTelegramCaption } from "./caption.js";
import { resolveTelegramFetch } from "./fetch.js";
import { renderTelegramHtmlText, splitTelegramHtmlChunks } from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramRateLimitError,
  isTelegramServerError,
} from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import {
  buildTelegramThreadReplyParams,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";
import {
  buildOutboundMediaLoadOptions,
  getImageMetadata,
  isGifMedia,
  kindFromMime,
  loadWebMedia,
  type MediaKind,
  normalizePollInput,
  type OpenClawConfig,
  type PollInput,
  requireRuntimeConfig,
  resolveMarkdownTableMode,
} from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { maybePersistResolvedTelegramTarget } from "./target-writeback.js";
import {
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
} from "./targets.js";
import { resolveTelegramVoiceSend } from "./voice.js";

export { buildInlineKeyboard } from "./inline-keyboard.js";

type TelegramApi = Bot["api"];
export type TelegramApiOverride = Partial<TelegramApi>;
type TelegramSendMessageParams = Parameters<TelegramApi["sendMessage"]>[2];
type TelegramSendPollParams = Parameters<TelegramApi["sendPoll"]>[3];
type TelegramEditMessageTextParams = Parameters<TelegramApi["editMessageText"]>[3];
type TelegramCreateForumTopicParams = NonNullable<Parameters<TelegramApi["createForumTopic"]>[2]>;
type TelegramThreadScopedParams = {
  message_thread_id?: number;
};
const InputFileCtor = grammy.InputFile;
const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 10_000;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;

type TelegramSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gatewayClientScopes?: readonly string[];
  maxBytes?: number;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  plainText?: string;
  /** Send audio as voice message instead of audio file. Defaults to false. */
  asVoice?: boolean;
  /** Send video as video note instead of regular video. Defaults to false. */
  asVideoNote?: boolean;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Quote text for Telegram reply_parameters. */
  quoteText?: string;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Inline keyboard buttons (reply markup). */
  buttons?: TelegramInlineButtons;
  /** Send image as document to avoid Telegram compression. Defaults to false. */
  forceDocument?: boolean;
};

type TelegramSendResult = {
  messageId: string;
  chatId: string;
};

type TelegramMessageLike = {
  message_id?: number;
  chat?: { id?: string | number };
};

type TelegramReactionOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  remove?: boolean;
  verbose?: boolean;
  retry?: RetryConfig;
};

type TelegramTypingOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  messageThreadId?: number;
};

function resolveTelegramMessageIdOrThrow(
  result: TelegramMessageLike | null | undefined,
  context: string,
): number {
  if (typeof result?.message_id === "number" && Number.isFinite(result.message_id)) {
    return Math.trunc(result.message_id);
  }
  throw new Error(`Telegram ${context} returned no message_id`);
}

function splitTelegramPlainTextChunks(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += normalizedLimit) {
    chunks.push(text.slice(start, start + normalizedLimit));
  }
  return chunks;
}

function splitTelegramPlainTextFallback(text: string, chunkCount: number, limit: number): string[] {
  if (!text) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const fixedChunks = splitTelegramPlainTextChunks(text, normalizedLimit);
  if (chunkCount <= 1 || fixedChunks.length >= chunkCount) {
    return fixedChunks;
  }
  const chunks: string[] = [];
  let offset = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const remainingChars = text.length - offset;
    const remainingChunks = chunkCount - index;
    const nextChunkLength =
      remainingChunks === 1
        ? remainingChars
        : Math.min(normalizedLimit, Math.ceil(remainingChars / remainingChunks));
    chunks.push(text.slice(offset, offset + nextChunkLength));
    offset += nextChunkLength;
  }
  return chunks;
}

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const MESSAGE_NOT_MODIFIED_RE =
  /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");
const telegramClientOptionsCache = new Map<string, ApiClientOptions | undefined>();
const MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE = 64;

function asTelegramClientFetch(
  fetchImpl: typeof globalThis.fetch,
): NonNullable<ApiClientOptions["fetch"]> {
  return fetchImpl as unknown as NonNullable<ApiClientOptions["fetch"]>;
}

export function resetTelegramClientOptionsCacheForTests(): void {
  telegramClientOptionsCache.clear();
}

function createTelegramHttpLogger(cfg: OpenClawConfig) {
  const enabled = isDiagnosticFlagEnabled("telegram.http", cfg);
  if (!enabled) {
    return () => {};
  }
  return (label: string, err: unknown) => {
    if (!(err instanceof HttpError)) {
      return;
    }
    const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
    diagLogger.warn(`telegram http error (${label}): ${detail}`);
  };
}

function shouldUseTelegramClientOptionsCache(): boolean {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

function buildTelegramClientOptionsCacheKey(params: {
  account: ResolvedTelegramAccount;
  timeoutSeconds?: number;
}): string {
  const proxyKey = params.account.config.proxy?.trim() ?? "";
  const autoSelectFamily = params.account.config.network?.autoSelectFamily;
  const autoSelectFamilyKey =
    typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default";
  const dnsResultOrderKey = params.account.config.network?.dnsResultOrder ?? "default";
  const apiRootKey = params.account.config.apiRoot?.trim() ?? "";
  const timeoutSecondsKey =
    typeof params.timeoutSeconds === "number" ? String(params.timeoutSeconds) : "default";
  return `${params.account.accountId}::${proxyKey}::${autoSelectFamilyKey}::${dnsResultOrderKey}::${apiRootKey}::${timeoutSecondsKey}`;
}

function setCachedTelegramClientOptions(
  cacheKey: string,
  clientOptions: ApiClientOptions | undefined,
): ApiClientOptions | undefined {
  telegramClientOptionsCache.set(cacheKey, clientOptions);
  if (telegramClientOptionsCache.size > MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE) {
    const oldestKey = telegramClientOptionsCache.keys().next().value;
    if (oldestKey !== undefined) {
      telegramClientOptionsCache.delete(oldestKey);
    }
  }
  return clientOptions;
}

function resolveTelegramClientOptions(
  account: ResolvedTelegramAccount,
): ApiClientOptions | undefined {
  const timeoutSeconds =
    typeof account.config.timeoutSeconds === "number" &&
    Number.isFinite(account.config.timeoutSeconds)
      ? Math.max(1, Math.floor(account.config.timeoutSeconds))
      : undefined;

  const cacheEnabled = shouldUseTelegramClientOptionsCache();
  const cacheKey = cacheEnabled
    ? buildTelegramClientOptionsCacheKey({
        account,
        timeoutSeconds,
      })
    : null;
  if (cacheKey && telegramClientOptionsCache.has(cacheKey)) {
    return telegramClientOptionsCache.get(cacheKey);
  }

  const proxyUrl = normalizeOptionalString(account.config.proxy);
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const apiRoot = normalizeOptionalString(account.config.apiRoot);
  const fetchImpl = resolveTelegramFetch(proxyFetch, {
    network: account.config.network,
  });
  const clientOptions =
    fetchImpl || timeoutSeconds || apiRoot
      ? {
          ...(fetchImpl ? { fetch: asTelegramClientFetch(fetchImpl) } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(apiRoot ? { apiRoot } : {}),
        }
      : undefined;
  if (cacheKey) {
    return setCachedTelegramClientOptions(cacheKey, clientOptions);
  }
  return clientOptions;
}

function resolveToken(explicit: string | undefined, params: { accountId: string; token: string }) {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.token) {
    throw new Error(
      `Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }
  return params.token.trim();
}

async function resolveChatId(
  to: string,
  params: { api: TelegramApiOverride; verbose?: boolean },
): Promise<string> {
  const numericChatId = normalizeTelegramChatId(to);
  if (numericChatId) {
    return numericChatId;
  }
  const lookupTarget = normalizeTelegramLookupTarget(to);
  const getChat = params.api.getChat;
  if (!lookupTarget || typeof getChat !== "function") {
    throw new Error("Telegram recipient must be a numeric chat ID");
  }
  try {
    const chat = await getChat.call(params.api, lookupTarget);
    const resolved = normalizeTelegramChatId(String(chat?.id ?? ""));
    if (!resolved) {
      throw new Error(`resolved chat id is not numeric (${String(chat?.id ?? "")})`);
    }
    if (params.verbose) {
      sendLogger.warn(`telegram recipient ${lookupTarget} resolved to numeric chat id ${resolved}`);
    }
    return resolved;
  } catch (err) {
    const detail = formatErrorMessage(err);
    throw new Error(
      `Telegram recipient ${lookupTarget} could not be resolved to a numeric chat ID (${detail})`,
      { cause: err },
    );
  }
}

async function resolveAndPersistChatId(params: {
  cfg: OpenClawConfig;
  api: TelegramApiOverride;
  lookupTarget: string;
  persistTarget: string;
  verbose?: boolean;
  gatewayClientScopes?: readonly string[];
}): Promise<string> {
  const chatId = await resolveChatId(params.lookupTarget, {
    api: params.api,
    verbose: params.verbose,
  });
  await maybePersistResolvedTelegramTarget({
    cfg: params.cfg,
    rawTarget: params.persistTarget,
    resolvedChatId: chatId,
    verbose: params.verbose,
    gatewayClientScopes: params.gatewayClientScopes,
  });
  return chatId;
}

function normalizeMessageId(raw: string | number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new Error("Message id is required for Telegram actions");
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error("Message id is required for Telegram actions");
}

function isTelegramThreadNotFoundError(err: unknown): boolean {
  return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}

function isTelegramMessageNotModifiedError(err: unknown): boolean {
  return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}

function hasMessageThreadIdParam(params?: TelegramThreadScopedParams): boolean {
  if (!params) {
    return false;
  }
  const value = params.message_thread_id;
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return false;
}

function removeMessageThreadIdParam<TParams extends TelegramThreadScopedParams | undefined>(
  params: TParams,
): TParams {
  if (!params || !hasMessageThreadIdParam(params)) {
    return params;
  }
  const next = { ...params };
  delete next.message_thread_id;
  return (Object.keys(next).length > 0 ? next : undefined) as TParams;
}

function isTelegramHtmlParseError(err: unknown): boolean {
  return PARSE_ERR_RE.test(formatErrorMessage(err));
}

async function withTelegramHtmlParseFallback<T>(params: {
  label: string;
  verbose?: boolean;
  requestHtml: (label: string) => Promise<T>;
  requestPlain: (label: string) => Promise<T>;
}): Promise<T> {
  try {
    return await params.requestHtml(params.label);
  } catch (err) {
    if (!isTelegramHtmlParseError(err)) {
      throw err;
    }
    if (params.verbose) {
      sendLogger.warn(
        `telegram ${params.label} failed with HTML parse error, retrying as plain text: ${formatErrorMessage(
          err,
        )}`,
      );
    }
    return await params.requestPlain(`${params.label}-plain`);
  }
}

type TelegramApiContext = {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
};

function resolveTelegramApiContext(opts: {
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  cfg: OpenClawConfig;
}): TelegramApiContext {
  const cfg = requireRuntimeConfig(opts.cfg, "Telegram API context");
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const client = resolveTelegramClientOptions(account);
  const api = (opts.api ?? new Bot(token, client ? { client } : undefined).api) as TelegramApi;
  return { cfg, account, api };
}

type TelegramRequestWithDiag = <T>(
  fn: () => Promise<T>,
  label?: string,
  options?: { shouldLog?: (err: unknown) => boolean },
) => Promise<T>;

function createTelegramRequestWithDiag(params: {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  retry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
  /** When true, the shouldRetry predicate is used exclusively without the TELEGRAM_RETRY_RE fallback. */
  strictShouldRetry?: boolean;
  useApiErrorLogging?: boolean;
}): TelegramRequestWithDiag {
  const request = createTelegramRetryRunner({
    retry: params.retry,
    configRetry: params.account.config.retry,
    verbose: params.verbose,
    ...(params.shouldRetry ? { shouldRetry: params.shouldRetry } : {}),
    ...(params.strictShouldRetry ? { strictShouldRetry: true } : {}),
  });
  const logHttpError = createTelegramHttpLogger(params.cfg);
  return <T>(
    fn: () => Promise<T>,
    label?: string,
    options?: { shouldLog?: (err: unknown) => boolean },
  ) => {
    const runRequest = () => request(fn, label);
    const call =
      params.useApiErrorLogging === false
        ? runRequest()
        : withTelegramApiErrorLogging({
            operation: label ?? "request",
            fn: runRequest,
            ...(options?.shouldLog ? { shouldLog: options.shouldLog } : {}),
          });
    return call.catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  };
}

function wrapTelegramChatNotFoundError(err: unknown, params: { chatId: string; input: string }) {
  const errorMsg = formatErrorMessage(err);

  // Check for 403 "bot is not a member" or "bot was blocked" errors
  if (/403.*(bot.*not.*member|bot.*blocked|bot.*kicked)/i.test(errorMsg)) {
    return new Error(
      [
        `Telegram send failed: bot is not a member of the chat, was blocked, or was kicked (chat_id=${params.chatId}).`,
        `Telegram API said: ${errorMsg}.`,
        "Fix: Add the bot to the channel/group, or ensure it has not been removed/blocked/kicked by the user.",
        `Input was: ${JSON.stringify(params.input)}.`,
      ].join(" "),
    );
  }

  if (!CHAT_NOT_FOUND_RE.test(errorMsg)) {
    return err;
  }
  return new Error(
    [
      `Telegram send failed: chat not found (chat_id=${params.chatId}).`,
      "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
      `Input was: ${JSON.stringify(params.input)}.`,
    ].join(" "),
  );
}

async function withTelegramThreadFallback<
  T,
  TParams extends TelegramThreadScopedParams | undefined,
>(
  params: TParams,
  label: string,
  verbose: boolean | undefined,
  attempt: (effectiveParams: TParams, effectiveLabel: string) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(params, label);
  } catch (err) {
    // Do not widen this fallback to cover "chat not found".
    // chat-not-found is routing/auth/membership/token; stripping thread IDs hides root cause.
    if (!hasMessageThreadIdParam(params) || !isTelegramThreadNotFoundError(err)) {
      throw err;
    }
    if (verbose) {
      sendLogger.warn(
        `telegram ${label} failed with message_thread_id, retrying without thread: ${formatErrorMessage(err)}`,
      );
    }
    const retriedParams = removeMessageThreadIdParam(params);
    return await attempt(retriedParams, `${label}-threadless`);
  }
}

function createRequestWithChatNotFound(params: {
  requestWithDiag: TelegramRequestWithDiag;
  chatId: string;
  input: string;
}) {
  return async <T>(fn: () => Promise<T>, label: string) =>
    params.requestWithDiag(fn, label).catch((err) => {
      throw wrapTelegramChatNotFoundError(err, {
        chatId: params.chatId,
        input: params.input,
      });
    });
}

function createTelegramNonIdempotentRequestWithDiag(params: {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  retry?: RetryConfig;
  verbose?: boolean;
  useApiErrorLogging?: boolean;
}): TelegramRequestWithDiag {
  return createTelegramRequestWithDiag({
    cfg: params.cfg,
    account: params.account,
    retry: params.retry,
    verbose: params.verbose,
    useApiErrorLogging: params.useApiErrorLogging,
    shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
    strictShouldRetry: true,
  });
}

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts,
): Promise<TelegramSendResult> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const mediaUrl = opts.mediaUrl?.trim();
  const mediaMaxBytes =
    opts.maxBytes ??
    (typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb : 100) * 1024 * 1024;
  const replyMarkup = buildInlineKeyboard(opts.buttons);

  const threadParams = buildTelegramThreadReplyParams({
    thread: resolveTelegramSendThreadSpec({
      targetMessageThreadId: target.messageThreadId,
      messageThreadId: opts.messageThreadId,
      chatType: target.chatType,
    }),
    replyToMessageId: opts.replyToMessageId,
    replyQuoteText: opts.quoteText,
    useReplyIdAsQuoteSource: true,
  });
  const hasThreadParams = Object.keys(threadParams).length > 0;
  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const requestWithChatNotFound = createRequestWithChatNotFound({
    requestWithDiag,
    chatId,
    input: to,
  });

  const textMode = opts.textMode ?? "markdown";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
  });
  const renderHtmlText = (value: string) => renderTelegramHtmlText(value, { textMode, tableMode });

  // Resolve link preview setting from config (default: enabled).
  const linkPreviewEnabled = account.config.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };

  type TelegramTextChunk = {
    plainText: string;
    htmlText?: string;
  };

  const sendTelegramTextChunk = async (
    chunk: TelegramTextChunk,
    params?: TelegramSendMessageParams,
  ) => {
    return await withTelegramThreadFallback(
      params,
      "message",
      opts.verbose,
      async (effectiveParams, label) => {
        const baseParams = effectiveParams ? { ...effectiveParams } : {};
        if (linkPreviewOptions) {
          baseParams.link_preview_options = linkPreviewOptions;
        }
        const plainParams: TelegramSendMessageParams = {
          ...baseParams,
          ...(opts.silent === true ? { disable_notification: true } : {}),
        };
        const hasPlainParams = Object.keys(plainParams).length > 0;
        const requestPlain = (retryLabel: string) =>
          requestWithChatNotFound(
            () =>
              hasPlainParams
                ? api.sendMessage(chatId, chunk.plainText, plainParams)
                : api.sendMessage(chatId, chunk.plainText),
            retryLabel,
          );
        if (!chunk.htmlText) {
          return await requestPlain(label);
        }
        const htmlText = chunk.htmlText;
        const htmlParams: TelegramSendMessageParams = {
          parse_mode: "HTML" as const,
          ...plainParams,
        };
        return await withTelegramHtmlParseFallback({
          label,
          verbose: opts.verbose,
          requestHtml: (retryLabel) =>
            requestWithChatNotFound(
              () => api.sendMessage(chatId, htmlText, htmlParams),
              retryLabel,
            ),
          requestPlain,
        });
      },
    );
  };

  const buildTextParams = (isLastChunk: boolean) =>
    hasThreadParams || (isLastChunk && replyMarkup)
      ? {
          ...threadParams,
          ...(isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;

  const sendTelegramTextChunks = async (
    chunks: TelegramTextChunk[],
    context: string,
  ): Promise<{ messageId: string; chatId: string }> => {
    let lastMessageId = "";
    let lastChatId = chatId;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      const res = await sendTelegramTextChunk(chunk, buildTextParams(index === chunks.length - 1));
      const messageId = resolveTelegramMessageIdOrThrow(res, context);
      recordSentMessage(chatId, messageId, cfg);
      lastMessageId = String(messageId);
      lastChatId = String(res?.chat?.id ?? chatId);
    }
    return { messageId: lastMessageId, chatId: lastChatId };
  };

  const buildChunkedTextPlan = (rawText: string, context: string): TelegramTextChunk[] => {
    const fallbackText = opts.plainText ?? rawText;
    let htmlChunks: string[];
    try {
      htmlChunks = splitTelegramHtmlChunks(rawText, 4000);
    } catch (error) {
      logVerbose(
        `telegram ${context} failed HTML chunk planning, retrying as plain text: ${formatErrorMessage(
          error,
        )}`,
      );
      return splitTelegramPlainTextChunks(fallbackText, 4000).map((plainText) => ({ plainText }));
    }
    const fixedPlainTextChunks = splitTelegramPlainTextChunks(fallbackText, 4000);
    if (fixedPlainTextChunks.length > htmlChunks.length) {
      logVerbose(
        `telegram ${context} plain-text fallback needs more chunks than HTML; sending plain text`,
      );
      return fixedPlainTextChunks.map((plainText) => ({ plainText }));
    }
    const plainTextChunks = splitTelegramPlainTextFallback(fallbackText, htmlChunks.length, 4000);
    return htmlChunks.map((htmlText, index) => ({
      htmlText,
      plainText: plainTextChunks[index] ?? htmlText,
    }));
  };

  const sendChunkedText = async (rawText: string, context: string) =>
    await sendTelegramTextChunks(buildChunkedTextPlan(rawText, context), context);

  async function shouldSendTelegramImageAsPhoto(buffer: Buffer): Promise<boolean> {
    try {
      const metadata = await getImageMetadata(buffer);
      const width = metadata?.width;
      const height = metadata?.height;

      if (typeof width !== "number" || typeof height !== "number") {
        sendLogger.warn("Photo dimensions are unavailable. Sending as document instead.");
        return false;
      }

      const shorterSide = Math.min(width, height);
      const longerSide = Math.max(width, height);
      const isValidPhoto =
        width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM &&
        shorterSide > 0 &&
        longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO;

      if (!isValidPhoto) {
        sendLogger.warn(
          `Photo dimensions (${width}x${height}) are not valid for Telegram photos. Sending as document instead.`,
        );
        return false;
      }
      return true;
    } catch (err) {
      sendLogger.warn(
        `Failed to validate photo dimensions: ${formatErrorMessage(err)}. Sending as document instead.`,
      );
      return false;
    }
  }

  if (mediaUrl) {
    const media = await loadWebMedia(
      mediaUrl,
      buildOutboundMediaLoadOptions({
        maxBytes: mediaMaxBytes,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        optimizeImages: opts.forceDocument ? false : undefined,
      }),
    );
    const kind = kindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });

    // Validate photo dimensions before attempting sendPhoto
    let sendImageAsPhoto = true;
    if (kind === "image" && !isGif && !opts.forceDocument) {
      sendImageAsPhoto = await shouldSendTelegramImageAsPhoto(media.buffer);
    }
    const isVideoNote = kind === "video" && opts.asVideoNote === true;
    const fileName =
      media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind ?? "document")) ?? "file";
    const file = new InputFileCtor(media.buffer, fileName);
    let caption: string | undefined;
    let followUpText: string | undefined;

    if (isVideoNote) {
      caption = undefined;
      followUpText = text.trim() ? text : undefined;
    } else {
      const split = splitTelegramCaption(text);
      caption = split.caption;
      followUpText = split.followUpText;
    }
    const htmlCaption = caption ? renderHtmlText(caption) : undefined;
    // If text exceeds Telegram's caption limit, send media without caption
    // then send text as a separate follow-up message.
    const needsSeparateText = Boolean(followUpText);
    // When splitting, put reply_markup only on the follow-up text (the "main" content),
    // not on the media message.
    const baseMediaParams = {
      ...(hasThreadParams ? threadParams : {}),
      ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    const mediaParams = {
      ...(htmlCaption ? { caption: htmlCaption, parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    const sendMedia = async (
      label: string,
      sender: (
        effectiveParams: TelegramThreadScopedParams | undefined,
      ) => Promise<TelegramMessageLike>,
    ) =>
      await withTelegramThreadFallback(
        mediaParams,
        label,
        opts.verbose,
        async (effectiveParams, retryLabel) =>
          requestWithChatNotFound(() => sender(effectiveParams), retryLabel),
      );

    const mediaSender = (() => {
      if (isGif && !opts.forceDocument) {
        return {
          label: "animation",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendAnimation(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendAnimation>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (kind === "image" && !opts.forceDocument && sendImageAsPhoto) {
        return {
          label: "photo",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendPhoto(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendPhoto>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (kind === "video") {
        if (isVideoNote) {
          return {
            label: "video_note",
            sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
              api.sendVideoNote(
                chatId,
                file,
                effectiveParams as Parameters<typeof api.sendVideoNote>[2],
              ) as Promise<TelegramMessageLike>,
          };
        }
        return {
          label: "video",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendVideo(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendVideo>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (kind === "audio") {
        const { useVoice } = resolveTelegramVoiceSend({
          wantsVoice: opts.asVoice === true, // default false (backward compatible)
          contentType: media.contentType,
          fileName,
          logFallback: logVerbose,
        });
        if (useVoice) {
          return {
            label: "voice",
            sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
              api.sendVoice(
                chatId,
                file,
                effectiveParams as Parameters<typeof api.sendVoice>[2],
              ) as Promise<TelegramMessageLike>,
          };
        }
        return {
          label: "audio",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendAudio(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendAudio>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      return {
        label: "document",
        sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
          api.sendDocument(
            chatId,
            file,
            // Only force Telegram to keep the uploaded media type when callers explicitly
            // opt into document delivery for image/GIF uploads.
            (opts.forceDocument
              ? { ...effectiveParams, disable_content_type_detection: true }
              : effectiveParams) as Parameters<typeof api.sendDocument>[2],
          ) as Promise<TelegramMessageLike>,
      };
    })();

    const result = await sendMedia(mediaSender.label, mediaSender.sender);
    const mediaMessageId = resolveTelegramMessageIdOrThrow(result, "media send");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    recordSentMessage(chatId, mediaMessageId, cfg);
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use HTML conversion so markdown renders like captions.
    if (needsSeparateText && followUpText) {
      if (textMode === "html") {
        const textResult = await sendChunkedText(followUpText, "text follow-up send");
        return { messageId: textResult.messageId, chatId: resolvedChatId };
      }
      const textResult = await sendTelegramTextChunks(
        [{ plainText: followUpText, htmlText: renderHtmlText(followUpText) }],
        "text follow-up send",
      );
      return { messageId: textResult.messageId, chatId: resolvedChatId };
    }

    return { messageId: String(mediaMessageId), chatId: resolvedChatId };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  let textResult: { messageId: string; chatId: string };
  if (textMode === "html") {
    textResult = await sendChunkedText(text, "text send");
  } else {
    textResult = await sendTelegramTextChunks(
      [{ plainText: opts.plainText ?? text, htmlText: renderHtmlText(text) }],
      "text send",
    );
  }
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return textResult;
}

export async function sendTypingTelegram(
  to: string,
  opts: TelegramTypingOpts,
): Promise<{ ok: true }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
  });
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const threadParams = buildTypingThreadParams(target.messageThreadId ?? opts.messageThreadId);
  await requestWithDiag(
    () =>
      api.sendChatAction(
        chatId,
        "typing",
        threadParams as Parameters<TelegramApi["sendChatAction"]>[2],
      ),
    "typing",
  );
  return { ok: true };
}

export async function reactMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: TelegramReactionOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const remove = opts.remove === true;
  const trimmedEmoji = emoji.trim();
  // Build the reaction array. We cast emoji to the grammY union type since
  // Telegram validates emoji server-side; invalid emojis fail gracefully.
  const reactions: ReactionType[] =
    remove || !trimmedEmoji
      ? []
      : [{ type: "emoji", emoji: trimmedEmoji as ReactionTypeEmoji["emoji"] }];
  if (typeof api.setMessageReaction !== "function") {
    throw new Error("Telegram reactions are unavailable in this bot API.");
  }
  try {
    await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (/REACTION_INVALID/i.test(msg)) {
      return { ok: false as const, warning: `Reaction unavailable: ${trimmedEmoji}` };
    }
    throw err;
  }
  return { ok: true };
}

type TelegramDeleteOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  notify?: boolean;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
};

export async function deleteMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts,
): Promise<{ ok: true }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage");
  logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
  return { ok: true };
}

export async function pinMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  await requestWithDiag(
    () =>
      api.pinChatMessage(chatId, messageId, {
        disable_notification: opts.notify !== true,
      }),
    "pinChatMessage",
  );
  logVerbose(`[telegram] Pinned message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}

export async function unpinMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number | undefined,
  opts: TelegramDeleteOpts,
): Promise<{ ok: true; chatId: string; messageId?: string }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
  });
  const messageId = messageIdInput === undefined ? undefined : normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  await requestWithDiag(() => api.unpinChatMessage(chatId, messageId), "unpinChatMessage");
  logVerbose(
    `[telegram] Unpinned ${messageId != null ? `message ${messageId}` : "active message"} in chat ${chatId}`,
  );
  return {
    ok: true,
    chatId,
    ...(messageId != null ? { messageId: String(messageId) } : {}),
  };
}

type TelegramEditForumTopicOpts = TelegramDeleteOpts & {
  name?: string;
  iconCustomEmojiId?: string;
};

export async function editForumTopicTelegram(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  opts: TelegramEditForumTopicOpts,
): Promise<{
  ok: true;
  chatId: string;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
}> {
  const nameProvided = opts.name !== undefined;
  const trimmedName = opts.name?.trim();
  if (nameProvided && !trimmedName) {
    throw new Error("Telegram forum topic name is required");
  }
  if (trimmedName && trimmedName.length > 128) {
    throw new Error("Telegram forum topic name must be 128 characters or fewer");
  }
  const iconProvided = opts.iconCustomEmojiId !== undefined;
  const trimmedIconCustomEmojiId = opts.iconCustomEmojiId?.trim();
  if (iconProvided && !trimmedIconCustomEmojiId) {
    throw new Error("Telegram forum topic icon custom emoji ID is required");
  }
  if (!trimmedName && !trimmedIconCustomEmojiId) {
    throw new Error("Telegram forum topic update requires a name or iconCustomEmojiId");
  }

  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const rawTarget = String(chatIdInput);
  const target = parseTelegramTarget(rawTarget);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: rawTarget,
    verbose: opts.verbose,
  });
  const messageThreadId = normalizeMessageId(messageThreadIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const payload = {
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(trimmedIconCustomEmojiId ? { icon_custom_emoji_id: trimmedIconCustomEmojiId } : {}),
  };
  await requestWithDiag(
    () => api.editForumTopic(chatId, messageThreadId, payload),
    "editForumTopic",
  );
  logVerbose(`[telegram] Edited forum topic ${messageThreadId} in chat ${chatId}`);
  return {
    ok: true,
    chatId,
    messageThreadId,
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(trimmedIconCustomEmojiId ? { iconCustomEmojiId: trimmedIconCustomEmojiId } : {}),
  };
}

export async function renameForumTopicTelegram(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  name: string,
  opts: TelegramDeleteOpts,
): Promise<{ ok: true; chatId: string; messageThreadId: number; name: string }> {
  const result = await editForumTopicTelegram(chatIdInput, messageThreadIdInput, {
    ...opts,
    name,
  });
  return {
    ok: true,
    chatId: result.chatId,
    messageThreadId: result.messageThreadId,
    name: result.name ?? name.trim(),
  };
}

type TelegramEditOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  /** Controls whether link previews are shown in the edited message. */
  linkPreview?: boolean;
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons;
  /** Resolved runtime config from the command or gateway boundary. */
  cfg: OpenClawConfig;
};

type TelegramEditReplyMarkupOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons;
  /** Resolved runtime config from the command or gateway boundary. */
  cfg: OpenClawConfig;
};

export async function editMessageReplyMarkupTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  buttons: TelegramInlineButtons,
  opts: TelegramEditReplyMarkupOpts,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = resolveTelegramApiContext({
    ...opts,
    cfg: opts.cfg,
  });
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const replyMarkup = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
  try {
    await requestWithDiag(
      () => api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup }),
      "editMessageReplyMarkup",
      {
        shouldLog: (err) => !isTelegramMessageNotModifiedError(err),
      },
    );
  } catch (err) {
    if (!isTelegramMessageNotModifiedError(err)) {
      throw err;
    }
  }
  logVerbose(`[telegram] Edited reply markup for message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}

export async function editMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  text: string,
  opts: TelegramEditOpts,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = resolveTelegramApiContext({
    ...opts,
    cfg: opts.cfg,
  });
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) =>
      isRecoverableTelegramNetworkError(err, { allowMessageMatch: true }) ||
      isTelegramServerError(err),
  });
  const requestWithEditShouldLog = <T>(
    fn: () => Promise<T>,
    label?: string,
    shouldLog?: (err: unknown) => boolean,
  ) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : undefined);

  const textMode = opts.textMode ?? "markdown";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
  });
  const htmlText = renderTelegramHtmlText(text, { textMode, tableMode });

  // Reply markup semantics:
  // - buttons === undefined → don't send reply_markup (keep existing)
  // - buttons is [] (or filters to empty) → send { inline_keyboard: [] } (remove)
  // - otherwise → send built inline keyboard
  const shouldTouchButtons = opts.buttons !== undefined;
  const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : undefined;
  const replyMarkup = shouldTouchButtons ? (builtKeyboard ?? { inline_keyboard: [] }) : undefined;

  const editParams: TelegramEditMessageTextParams = {
    parse_mode: "HTML",
  };
  if (opts.linkPreview === false) {
    editParams.link_preview_options = { is_disabled: true };
  }
  if (replyMarkup !== undefined) {
    editParams.reply_markup = replyMarkup;
  }
  const plainParams: TelegramEditMessageTextParams = {};
  if (opts.linkPreview === false) {
    plainParams.link_preview_options = { is_disabled: true };
  }
  if (replyMarkup !== undefined) {
    plainParams.reply_markup = replyMarkup;
  }

  try {
    await withTelegramHtmlParseFallback({
      label: "editMessage",
      verbose: opts.verbose,
      requestHtml: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageText(chatId, messageId, htmlText, editParams),
          retryLabel,
          (err) => !isTelegramMessageNotModifiedError(err),
        ),
      requestPlain: (retryLabel) =>
        requestWithEditShouldLog(
          () =>
            Object.keys(plainParams).length > 0
              ? api.editMessageText(chatId, messageId, text, plainParams)
              : api.editMessageText(chatId, messageId, text),
          retryLabel,
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        ),
    });
  } catch (err) {
    if (isTelegramMessageNotModifiedError(err)) {
      // no-op: Telegram reports message content unchanged, treat as success
    } else {
      throw err;
    }
  }

  logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}

function inferFilename(kind: MediaKind) {
  switch (kind) {
    case "image":
      return "image.jpg";
    case "video":
      return "video.mp4";
    case "audio":
      return "audio.ogg";
    default:
      return "file.bin";
  }
}

type TelegramStickerOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
};

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts,
): Promise<TelegramSendResult> {
  if (!fileId?.trim()) {
    throw new Error("Telegram sticker file_id is required");
  }

  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
  });

  const threadParams = buildTelegramThreadReplyParams({
    thread: resolveTelegramSendThreadSpec({
      targetMessageThreadId: target.messageThreadId,
      messageThreadId: opts.messageThreadId,
      chatType: target.chatType,
    }),
    replyToMessageId: opts.replyToMessageId,
  });
  const hasThreadParams = Object.keys(threadParams).length > 0;

  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    useApiErrorLogging: false,
  });
  const requestWithChatNotFound = createRequestWithChatNotFound({
    requestWithDiag,
    chatId,
    input: to,
  });

  const stickerParams = hasThreadParams ? threadParams : undefined;

  const result = await withTelegramThreadFallback(
    stickerParams,
    "sticker",
    opts.verbose,
    async (effectiveParams, label) =>
      requestWithChatNotFound(() => api.sendSticker(chatId, fileId.trim(), effectiveParams), label),
  );

  const messageId = resolveTelegramMessageIdOrThrow(result, "sticker send");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  recordSentMessage(chatId, messageId, opts.cfg);
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId: String(messageId), chatId: resolvedChatId };
}

type TelegramPollOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Whether votes are anonymous. Defaults to true (Telegram default). */
  isAnonymous?: boolean;
};

/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
export async function sendPollTelegram(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts,
): Promise<{ messageId: string; chatId: string; pollId?: string }> {
  const { cfg, account, api } = resolveTelegramApiContext(opts);
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });

  // Normalize the poll input (validates question, options, maxSelections)
  const normalizedPoll = normalizePollInput(poll, { maxOptions: 10 });

  const threadParams = buildTelegramThreadReplyParams({
    thread: resolveTelegramSendThreadSpec({
      targetMessageThreadId: target.messageThreadId,
      messageThreadId: opts.messageThreadId,
      chatType: target.chatType,
    }),
    replyToMessageId: opts.replyToMessageId,
  });

  // Build poll options as simple strings (Grammy accepts string[] or InputPollOption[])
  const pollOptions = normalizedPoll.options;

  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const requestWithChatNotFound = createRequestWithChatNotFound({
    requestWithDiag,
    chatId,
    input: to,
  });

  const durationSeconds = normalizedPoll.durationSeconds;
  if (durationSeconds === undefined && normalizedPoll.durationHours !== undefined) {
    throw new Error(
      "Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.",
    );
  }
  if (durationSeconds !== undefined && (durationSeconds < 5 || durationSeconds > 600)) {
    throw new Error("Telegram poll durationSeconds must be between 5 and 600");
  }

  // Build poll parameters following Grammy's api.sendPoll signature
  // sendPoll(chat_id, question, options, other?, signal?)
  const pollParams: TelegramSendPollParams = {
    allows_multiple_answers: normalizedPoll.maxSelections > 1,
    is_anonymous: opts.isAnonymous ?? true,
    ...(durationSeconds !== undefined ? { open_period: durationSeconds } : {}),
    ...(Object.keys(threadParams).length > 0 ? threadParams : {}),
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };

  const result = await withTelegramThreadFallback(
    pollParams,
    "poll",
    opts.verbose,
    async (effectiveParams, label) =>
      requestWithChatNotFound(
        () => api.sendPoll(chatId, normalizedPoll.question, pollOptions, effectiveParams),
        label,
      ),
  );

  const messageId = resolveTelegramMessageIdOrThrow(result, "poll send");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  const pollId = result?.poll?.id;
  recordSentMessage(chatId, messageId, opts.cfg);

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId: String(messageId), chatId: resolvedChatId, pollId };
}

// ---------------------------------------------------------------------------
// Forum topic creation
// ---------------------------------------------------------------------------

type TelegramCreateForumTopicOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  verbose?: boolean;
  retry?: RetryConfig;
  /** Icon color for the topic (must be one of 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F). */
  iconColor?: TelegramCreateForumTopicParams["icon_color"];
  /** Custom emoji ID for the topic icon. */
  iconCustomEmojiId?: string;
};

export type TelegramCreateForumTopicResult = {
  topicId: number;
  name: string;
  chatId: string;
};

/**
 * Create a forum topic in a Telegram supergroup.
 * Requires the bot to have `can_manage_topics` permission.
 *
 * @param chatId - Supergroup chat ID
 * @param name - Topic name (1-128 characters)
 * @param opts - Optional configuration
 */
export async function createForumTopicTelegram(
  chatId: string,
  name: string,
  opts: TelegramCreateForumTopicOpts,
): Promise<TelegramCreateForumTopicResult> {
  if (!name?.trim()) {
    throw new Error("Forum topic name is required");
  }
  const trimmedName = name.trim();
  if (trimmedName.length > 128) {
    throw new Error("Forum topic name must be 128 characters or fewer");
  }

  const { cfg, account, api } = resolveTelegramApiContext(opts);
  // Accept topic-qualified targets (e.g. telegram:group:<id>:topic:<thread>)
  // but createForumTopic must always target the base supergroup chat id.
  const target = parseTelegramTarget(chatId);
  const normalizedChatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: chatId,
    verbose: opts.verbose,
  });

  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });

  const extra: TelegramCreateForumTopicParams = {};
  if (opts.iconColor != null) {
    extra.icon_color = opts.iconColor;
  }
  if (opts.iconCustomEmojiId?.trim()) {
    extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
  }

  const hasExtra = Object.keys(extra).length > 0;
  const result = await requestWithDiag(
    () => api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : undefined),
    "createForumTopic",
  );

  const topicId = result.message_thread_id;

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    topicId,
    name: result.name ?? trimmedName,
    chatId: normalizedChatId,
  };
}
