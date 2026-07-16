// Telegram plugin module implements send behavior.
import * as grammy from "grammy";
import { type ApiClientOptions, Bot, HttpError } from "grammy";
import type { ReactionType, ReactionTypeEmoji } from "grammy/types";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  formatLocationText,
  normalizeOutboundLocation,
  type OutboundLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import { formatUncaughtError } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { createTelegramRetryRunner, type RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { buildTypingThreadParams } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { splitTelegramCaption } from "./caption.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport, type TelegramTransport } from "./fetch.js";
import {
  renderTelegramHtmlText,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramRateLimitError,
  isTelegramServerError,
} from "./network-errors.js";
import {
  recordOutboundMessageForPromptContext,
  type TelegramOutboundPromptContextMessage as TelegramMessageLike,
} from "./outbound-message-context.js";
import type { createTelegramPromptContextProjectionCursor } from "./prompt-context-projection.js";
import { makeProxyFetch } from "./proxy.js";
import {
  buildTelegramThreadReplyParams,
  getTelegramNativeQuoteReplyMessageId,
  isTelegramQuoteParamError,
  removeTelegramNativeQuoteParam,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";
import { TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS } from "./retry-after.js";
import {
  buildTelegramRichMarkdownPlan,
  getTelegramRichRawApi,
  isEmptyTelegramRichMessage,
  removeTelegramRichNativeQuoteParam,
  splitTelegramRichMessageTextChunks,
  TELEGRAM_RICH_TEXT_LIMIT,
  toTelegramRichMessageContextParams,
  type TelegramEditRichMessageTextParams,
  type TelegramRichMessageContextParams,
  type TelegramRichTextChunk,
} from "./rich-message.js";
import {
  buildTelegramPlainFallbackPlan,
  isTelegramHtmlParseError,
  splitTelegramPlainTextChunks,
  warnTelegramRichBlocksDegradations,
} from "./rich-plain-fallback.js";
import {
  buildOutboundMediaLoadOptions,
  getImageMetadata,
  isGifMedia,
  kindFromMime,
  loadWebMedia,
  type MediaKind,
  normalizePollInput,
  probeVideoDimensions,
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
import { resolveTelegramBotUserIdFromToken } from "./token.js";
import { resolveTelegramVoiceSend } from "./voice.js";

export { buildInlineKeyboard } from "./inline-keyboard.js";

type TelegramApi = Bot["api"];
export type TelegramApiOverride = Partial<TelegramApi>;
type TelegramSendMessageParams = Parameters<TelegramApi["sendMessage"]>[2];
type TelegramSendPollParams = Parameters<TelegramApi["sendPoll"]>[3];
type TelegramSendLocationParams = Parameters<TelegramApi["sendLocation"]>[3];
type TelegramSendVenueParams = Parameters<TelegramApi["sendVenue"]>[5];
type TelegramEditMessageTextParams = Parameters<TelegramApi["editMessageText"]>[3];
type TelegramEditMessageCaptionParams = Parameters<TelegramApi["editMessageCaption"]>[2];
type TelegramCreateForumTopicParams = NonNullable<Parameters<TelegramApi["createForumTopic"]>[2]>;
type TelegramThreadScopedParams = {
  message_thread_id?: number;
  reply_parameters?: { message_id?: number };
  reply_to_message_id?: number;
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
  tableMode?: MarkdownTableMode;
  /** Send audio as voice message instead of audio file. Defaults to false. */
  asVoice?: boolean;
  /** Send video as video note instead of regular video. Defaults to false. */
  asVideoNote?: boolean;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Shared cursor keeps one transcript projection contiguous across concrete sends. */
  promptContextProjectionPlan?: {
    cursor: ReturnType<typeof createTelegramPromptContextProjectionCursor>;
    finalPart: boolean;
  };
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Whether replyToMessageId came from ambient context or explicit payload/action input. */
  replyToIdSource?: "explicit" | "implicit";
  /** Controls whether replyToMessageId is applied to every internal text chunk. */
  replyToMode?: ReplyToMode;
  /** Quote text for Telegram reply_parameters. */
  quoteText?: string;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Inline keyboard buttons (reply markup). */
  buttons?: TelegramInlineButtons;
  /** Send image as document to avoid Telegram compression. Defaults to false. */
  forceDocument?: boolean;
  /** Persist each concrete platform send before any later chunk can fail. */
  onDeliveryResult?: (result: TelegramSendResult) => Promise<void> | void;
};

type TelegramSendResult = {
  messageId: string;
  chatId: string;
  receipt?: MessageReceipt;
};

type TelegramLocationSendOpts = Pick<
  TelegramSendOpts,
  | "cfg"
  | "token"
  | "accountId"
  | "verbose"
  | "api"
  | "retry"
  | "gatewayClientScopes"
  | "replyToMessageId"
  | "messageThreadId"
  | "buttons"
  | "quoteText"
  | "promptContextProjectionPlan"
  | "silent"
  | "onDeliveryResult"
>;

type TelegramOutboundSuccessLogParams = {
  accountId: string;
  chatId: string;
  messageId: string;
  operation: string;
  deliveryKind?: string;
  messageThreadId?: number;
  replyToMessageId?: number;
  silent?: boolean;
  chunkCount?: number;
};

type TelegramReactionOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  remove?: boolean;
  verbose?: boolean;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
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

// Test-only handle: the plain-text splitter is internal, but its surrogate-safe
// chunk boundary needs direct behavior coverage.
export function splitTelegramPlainTextChunksForTests(text: string, limit: number): string[] {
  return splitTelegramPlainTextChunks(text, limit);
}

function logTelegramOutboundSendOk(params: TelegramOutboundSuccessLogParams): void {
  const parts = [
    "telegram outbound send ok",
    `accountId=${params.accountId}`,
    `chatId=${params.chatId}`,
    `messageId=${params.messageId}`,
    `operation=${params.operation}`,
  ];
  if (params.deliveryKind) {
    parts.push(`deliveryKind=${params.deliveryKind}`);
  }
  if (typeof params.messageThreadId === "number") {
    parts.push(`threadId=${params.messageThreadId}`);
  }
  if (typeof params.replyToMessageId === "number") {
    parts.push(`replyToMessageId=${params.replyToMessageId}`);
  }
  if (params.silent === true) {
    parts.push("silent=true");
  }
  if (typeof params.chunkCount === "number") {
    parts.push(`chunkCount=${params.chunkCount}`);
  }
  sendLogger.info(parts.join(" "));
}

function buildTelegramTextSendReceipt(params: {
  messageIds: readonly string[];
  chatId: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}): MessageReceipt | undefined {
  if (params.messageIds.length <= 1) {
    return undefined;
  }
  return createMessageReceiptFromOutboundResults({
    results: params.messageIds.map((messageId) => ({
      messageId,
      chatId: params.chatId,
    })),
    kind: "text",
    ...(typeof params.messageThreadId === "number"
      ? { threadId: String(params.messageThreadId) }
      : {}),
    ...(typeof params.replyToMessageId === "number"
      ? { replyToId: String(params.replyToMessageId) }
      : {}),
  });
}

function resolveAcceptedReplyToMessageId(
  params: TelegramThreadScopedParams | TelegramRichMessageContextParams | undefined,
): number | undefined {
  if (!params) {
    return undefined;
  }
  if ("reply_to_message_id" in params) {
    return params.reply_to_message_id;
  }
  return params.reply_parameters?.message_id;
}

function toAcceptedThreadScopedParams(
  params: Record<string, unknown> | undefined,
): TelegramThreadScopedParams | undefined {
  if (!params) {
    return undefined;
  }
  const scoped: TelegramThreadScopedParams = {};
  if (typeof params.message_thread_id === "number" && Number.isFinite(params.message_thread_id)) {
    scoped.message_thread_id = params.message_thread_id;
  }
  if (
    typeof params.reply_to_message_id === "number" &&
    Number.isFinite(params.reply_to_message_id)
  ) {
    scoped.reply_to_message_id = params.reply_to_message_id;
  }
  const replyParameters = params.reply_parameters;
  if (replyParameters && typeof replyParameters === "object") {
    const messageId = (replyParameters as { message_id?: unknown }).message_id;
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      scoped.reply_parameters = { message_id: messageId };
    }
  }
  return Object.keys(scoped).length > 0 ? scoped : undefined;
}

const MESSAGE_NOT_MODIFIED_RE =
  /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_HAS_NO_TEXT_RE = /400:\s*Bad Request:\s*there is no text in the message to edit/i;
const MESSAGE_DELETE_NOOP_RE =
  /message to delete not found|message can't be deleted|MESSAGE_ID_INVALID|MESSAGE_DELETE_FORBIDDEN/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");
type CachedTelegramClientOptions = {
  activeLeases: number;
  clientOptions: ApiClientOptions | undefined;
  closeStarted: boolean;
  retired: boolean;
  transport: TelegramTransport;
};
type TelegramClientOptionsLease = {
  release: () => void;
};
type ResolvedTelegramClientOptions = {
  clientOptions: ApiClientOptions | undefined;
  lease?: () => TelegramClientOptionsLease;
};
const telegramClientOptionsCache = new Map<string, CachedTelegramClientOptions>();
const MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE = 64;

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

function closeCachedTelegramClientOptions(entry: CachedTelegramClientOptions): void {
  // Eviction may retire a cache entry while a send still holds a lease; defer
  // transport.close until the last op-level lease releases so mid-request sockets stay open.
  entry.retired = true;
  if (entry.activeLeases > 0 || entry.closeStarted) {
    return;
  }
  entry.closeStarted = true;
  void entry.transport.close().catch((err: unknown) => {
    diagLogger.warn(
      `telegram client options cache transport close failed: ${redactSensitiveText(
        formatUncaughtError(err),
      )}`,
    );
  });
}

function leaseCachedTelegramClientOptions(
  entry: CachedTelegramClientOptions,
): TelegramClientOptionsLease {
  entry.activeLeases += 1;
  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      entry.activeLeases = Math.max(0, entry.activeLeases - 1);
      if (entry.retired) {
        closeCachedTelegramClientOptions(entry);
      }
    },
  };
}

function setCachedTelegramClientOptions(
  cacheKey: string,
  entry: CachedTelegramClientOptions,
): ResolvedTelegramClientOptions {
  telegramClientOptionsCache.set(cacheKey, entry);
  if (telegramClientOptionsCache.size > MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE) {
    const oldestKey = telegramClientOptionsCache.keys().next().value;
    if (oldestKey !== undefined) {
      const evictedEntry = telegramClientOptionsCache.get(oldestKey);
      telegramClientOptionsCache.delete(oldestKey);
      if (evictedEntry) {
        closeCachedTelegramClientOptions(evictedEntry);
      }
    }
  }
  return {
    clientOptions: entry.clientOptions,
    lease: () => leaseCachedTelegramClientOptions(entry),
  };
}

function resolveTelegramClientOptions(
  account: ResolvedTelegramAccount,
): ResolvedTelegramClientOptions {
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
    const entry = telegramClientOptionsCache.get(cacheKey);
    if (entry) {
      return {
        clientOptions: entry.clientOptions,
        lease: () => leaseCachedTelegramClientOptions(entry),
      };
    }
  }

  const proxyUrl = normalizeOptionalString(account.config.proxy);
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const apiRoot = normalizeOptionalString(account.config.apiRoot);
  const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : undefined;
  const transport = resolveTelegramTransport(proxyFetch, {
    network: account.config.network,
  });
  const fetchImpl = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(transport.fetch),
    timeoutSeconds,
    transport,
  });
  const clientOptions =
    fetchImpl || timeoutSeconds || normalizedApiRoot
      ? {
          ...(fetchImpl ? { fetch: asTelegramClientFetch(fetchImpl) } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}),
        }
      : undefined;
  if (cacheKey) {
    return setCachedTelegramClientOptions(cacheKey, {
      activeLeases: 0,
      clientOptions,
      closeStarted: false,
      retired: false,
      transport,
    });
  }
  return { clientOptions };
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
    ...(params.gatewayClientScopes === undefined ? { trustedInternalWriteback: true } : {}),
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
    const parsed = parseStrictInteger(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  throw new Error("Message id is required for Telegram actions");
}

function isTelegramMessageNotModifiedError(err: unknown): boolean {
  return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}

function isTelegramMessageHasNoTextError(err: unknown): boolean {
  return MESSAGE_HAS_NO_TEXT_RE.test(formatErrorMessage(err));
}

function isTelegramMessageDeleteNoopError(err: unknown): boolean {
  return MESSAGE_DELETE_NOOP_RE.test(formatErrorMessage(err));
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

async function withTelegramNativeQuoteFallback<T>(params: {
  label: string;
  requestParams: Record<string, unknown>;
  request: (requestParams: Record<string, unknown>, label: string) => Promise<T>;
  removeNativeQuoteParam?: (requestParams: Record<string, unknown>) => Record<string, unknown>;
}): Promise<{ result: T; acceptedParams: Record<string, unknown> }> {
  try {
    return {
      result: await params.request(params.requestParams, params.label),
      acceptedParams: params.requestParams,
    };
  } catch (err) {
    if (
      getTelegramNativeQuoteReplyMessageId(params.requestParams) == null ||
      !isTelegramQuoteParamError(err)
    ) {
      throw err;
    }
    // Mirror delivery.send.ts legacy-reply retry: model quotes can drift from
    // the source text, but final replies should keep the message reply target.
    sendLogger.warn(
      `telegram ${params.label} native quote rejected, retrying with legacy reply_to_message_id: ${formatErrorMessage(
        err,
      )}`,
    );
    const acceptedParams = (params.removeNativeQuoteParam ?? removeTelegramNativeQuoteParam)(
      params.requestParams,
    );
    return {
      result: await params.request(acceptedParams, `${params.label}-legacy-reply`),
      acceptedParams,
    };
  }
}

type TelegramApiContext = {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
  clientOptionsLease?: TelegramClientOptionsLease | undefined;
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
  let api: TelegramApi;
  let clientOptionsLease: TelegramClientOptionsLease | undefined;
  if (opts.api) {
    api = opts.api as TelegramApi;
  } else {
    const client = resolveTelegramClientOptions(account);
    // One op-level lease covers the full send/action (including pre-request work
    // and retries) so eviction cannot close the transport mid-operation.
    clientOptionsLease = client.lease?.();
    const bot = new Bot(token, client.clientOptions ? { client: client.clientOptions } : undefined);
    bot.api.config.use(getOrCreateAccountThrottler(token));
    api = bot.api;
  }
  return {
    cfg,
    account,
    api,
    ...(clientOptionsLease ? { clientOptionsLease } : {}),
  };
}

function withTelegramApiContextLease<T>(
  context: TelegramApiContext,
  operation: Promise<T>,
): Promise<T> {
  return operation.finally(() => context.clientOptionsLease?.release());
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
  retryAfterMaxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  /** When true, the shouldRetry predicate is used exclusively without the TELEGRAM_RETRY_RE fallback. */
  strictShouldRetry?: boolean;
  useApiErrorLogging?: boolean;
}): TelegramRequestWithDiag {
  const request = createTelegramRetryRunner({
    retry: params.retry,
    configRetry: params.account.config.retry,
    verbose: params.verbose,
    ...(params.retryAfterMaxDelayMs !== undefined
      ? { retryAfterMaxDelayMs: params.retryAfterMaxDelayMs }
      : {}),
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
    return call.catch((err: unknown) => {
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

function createRequestWithChatNotFound(params: {
  requestWithDiag: TelegramRequestWithDiag;
  chatId: string;
  input: string;
}) {
  return async <T>(fn: () => Promise<T>, label: string) =>
    params.requestWithDiag(fn, label).catch((err: unknown) => {
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
    retryAfterMaxDelayMs: TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS,
    shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
    strictShouldRetry: true,
  });
}

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts,
): Promise<TelegramSendResult> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    sendMessageTelegramWithContext(to, text, opts, context),
  );
}

async function sendMessageTelegramWithContext(
  to: string,
  text: string,
  opts: TelegramSendOpts,
  apiContext: TelegramApiContext,
): Promise<TelegramSendResult> {
  const { cfg, account, api } = apiContext;
  const botUserId = resolveTelegramBotUserIdFromToken(opts.token || account.token);
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const reportDelivery = async (messageId: string | number, deliveredChatId: string | number) => {
    await opts.onDeliveryResult?.({
      messageId: String(messageId),
      chatId: String(deliveredChatId),
    });
  };
  const recordDeliveredPromptContext = async (
    params: Omit<
      Parameters<typeof recordOutboundMessageForPromptContext>[0],
      "cfg" | "account" | "botUserId" | "chatId" | "promptContextProjection"
    >,
    finalPart: boolean,
  ) => {
    const plan = opts.promptContextProjectionPlan;
    const projection = plan?.cursor.take(plan.finalPart && finalPart);
    const recorded = await recordOutboundMessageForPromptContext({
      cfg,
      account,
      ...(botUserId !== undefined ? { botUserId } : {}),
      chatId,
      ...params,
      promptContextProjection: projection,
    });
    if (projection && !recorded) {
      // A delivered-but-uncached part must prevent later parts from claiming
      // complete transcript coverage.
      plan?.cursor.invalidate();
    }
  };
  const mediaUrl = opts.mediaUrl?.trim();
  const mediaMaxBytes =
    opts.maxBytes ??
    (typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb : 100) * 1024 * 1024;
  const replyMarkup = buildInlineKeyboard(opts.buttons);

  const threadSpec = resolveTelegramSendThreadSpec({
    targetMessageThreadId: target.messageThreadId,
    messageThreadId: opts.messageThreadId,
    chatType: target.chatType,
  });
  const singleUseReplyTo =
    opts.replyToIdSource === "implicit" &&
    opts.replyToMode !== undefined &&
    isSingleUseReplyToMode(opts.replyToMode);
  const buildThreadParams = (includeReplyTo: boolean) =>
    buildTelegramThreadReplyParams({
      thread: threadSpec,
      ...(includeReplyTo
        ? {
            replyToMessageId: opts.replyToMessageId,
            replyQuoteText: opts.quoteText,
            useReplyIdAsQuoteSource: true,
          }
        : {}),
    });
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
  // Caller-authored HTML keeps legacy parse_mode HTML semantics (literal
  // newlines, 4096 chunking) even on rich accounts; blocks are markdown-only.
  const useRichMessages = account.config.richMessages === true && textMode !== "html";
  const tableMode =
    opts.tableMode ??
    resolveMarkdownTableMode({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      supportsBlockTables: useRichMessages,
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
    const baseParams = params ? { ...params } : {};
    if (linkPreviewOptions) {
      baseParams.link_preview_options = linkPreviewOptions;
    }
    const plainParams: TelegramSendMessageParams = {
      ...baseParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    const requestSendMessage = (
      label: string,
      messageText: string,
      requestParams: Record<string, unknown>,
    ) =>
      withTelegramNativeQuoteFallback({
        label,
        requestParams,
        request: (effectiveParams, retryLabel) =>
          requestWithChatNotFound(
            () =>
              Object.keys(effectiveParams).length > 0
                ? api.sendMessage(chatId, messageText, effectiveParams)
                : api.sendMessage(chatId, messageText),
            retryLabel,
          ),
      });
    const requestPlain = (label: string) =>
      requestSendMessage(label, chunk.plainText, plainParams ?? {});
    const result = !chunk.htmlText
      ? await requestPlain("message")
      : await withTelegramHtmlParseFallback({
          label: "message",
          verbose: opts.verbose,
          requestHtml: (label) =>
            requestSendMessage(label, chunk.htmlText ?? chunk.plainText, {
              parse_mode: "HTML" as const,
              ...plainParams,
            }),
          requestPlain,
        });
    return {
      result: result.result,
      acceptedParams: toAcceptedThreadScopedParams(result.acceptedParams),
    };
  };

  const shouldIncludeReplyForChunk = (
    index: number,
    chunkCount: number,
    replyToAlreadyUsed: boolean,
  ) =>
    // Telegram Desktop can render long formatted reply chunks as unsupported messages.
    // Multi-part `first` replies keep chat/topic routing but avoid hiding chunk text.
    !replyToAlreadyUsed && (!singleUseReplyTo || (chunkCount === 1 && index === 0));

  const buildTextParams = (
    index: number,
    chunkCount: number,
    isLastChunk: boolean,
    replyToAlreadyUsed: boolean,
  ) => {
    const params = buildThreadParams(
      shouldIncludeReplyForChunk(index, chunkCount, replyToAlreadyUsed),
    );
    return Object.keys(params).length > 0 || (isLastChunk && replyMarkup)
      ? {
          ...params,
          ...(isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  };

  const buildRichTextParams = (
    index: number,
    chunkCount: number,
    isLastChunk: boolean,
    replyToAlreadyUsed: boolean,
  ) => {
    const params = toTelegramRichMessageContextParams(
      buildThreadParams(shouldIncludeReplyForChunk(index, chunkCount, replyToAlreadyUsed)),
    );
    return Object.keys(params).length > 0 || (isLastChunk && replyMarkup)
      ? {
          ...params,
          ...(isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  };

  const sendTelegramTextChunks = async (
    chunks: TelegramTextChunk[],
    context: string,
    options: { replyToAlreadyUsed?: boolean } = {},
  ): Promise<TelegramSendResult> => {
    let lastMessageId = "";
    let lastChatId = chatId;
    let lastAcceptedParams: TelegramThreadScopedParams | undefined;
    let acceptedReplyToMessageId: number | undefined;
    const messageIds: string[] = [];
    let sentChunkCount = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      const { result: res, acceptedParams } = await sendTelegramTextChunk(
        chunk,
        buildTextParams(
          index,
          chunks.length,
          index === chunks.length - 1,
          options.replyToAlreadyUsed === true,
        ),
      );
      const messageId = resolveTelegramMessageIdOrThrow(res, context);
      recordSentMessage(chatId, messageId, cfg);
      await reportDelivery(messageId, res?.chat?.id ?? chatId);
      await recordDeliveredPromptContext(
        {
          message: res,
          messageId,
          text: chunk.plainText,
          ...(acceptedParams?.message_thread_id !== undefined
            ? { messageThreadId: acceptedParams.message_thread_id }
            : {}),
        },
        index === chunks.length - 1,
      );
      lastMessageId = String(messageId);
      lastChatId = String(res?.chat?.id ?? chatId);
      lastAcceptedParams = acceptedParams;
      acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(acceptedParams);
      messageIds.push(lastMessageId);
      sentChunkCount += 1;
    }
    if (lastMessageId) {
      logTelegramOutboundSendOk({
        accountId: account.accountId,
        chatId: lastChatId,
        messageId: lastMessageId,
        operation: "sendMessage",
        deliveryKind: "text",
        messageThreadId: lastAcceptedParams?.message_thread_id,
        replyToMessageId: opts.replyToMessageId,
        silent: opts.silent,
        chunkCount: sentChunkCount,
      });
    }
    const receipt = buildTelegramTextSendReceipt({
      messageIds,
      chatId: lastChatId,
      messageThreadId: lastAcceptedParams?.message_thread_id,
      replyToMessageId: acceptedReplyToMessageId,
    });
    return {
      messageId: lastMessageId,
      chatId: lastChatId,
      ...(receipt ? { receipt } : {}),
    };
  };

  const buildChunkedTextPlan = (rawText: string, context: string): TelegramTextChunk[] => {
    const htmlText = renderHtmlText(rawText);
    const fallbackText = textMode === "html" ? telegramHtmlToPlainTextFallback(htmlText) : rawText;
    let htmlChunks: string[];
    try {
      htmlChunks = splitTelegramHtmlChunks(htmlText, 4000);
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
    return htmlChunks.map((htmlTextLocal) => ({
      htmlText: htmlTextLocal,
      plainText: telegramHtmlToPlainTextFallback(htmlTextLocal),
    }));
  };

  const sendChunkedText = async (
    rawText: string,
    context: string,
    options: { replyToAlreadyUsed?: boolean } = {},
  ) => {
    try {
      return useRichMessages
        ? await sendTelegramRichTextChunks(buildRichTextPlan(rawText), context, options)
        : await sendTelegramTextChunks(buildChunkedTextPlan(rawText, context), context, options);
    } catch (error) {
      opts.promptContextProjectionPlan?.cursor.invalidate();
      throw error;
    }
  };

  const buildRichTextPlan = (rawText: string): TelegramRichTextChunk[] => {
    const textLimit = Math.min(
      resolveTextChunkLimit(cfg, "telegram", account.accountId, {
        fallbackLimit: TELEGRAM_RICH_TEXT_LIMIT,
      }),
      TELEGRAM_RICH_TEXT_LIMIT,
    );
    return splitTelegramRichMessageTextChunks({
      text: rawText,
      textLimit,
      tableMode,
      skipEntityDetection: account.config.linkPreview === false,
    });
  };

  const sendTelegramRichTextChunks = async (
    chunks: TelegramRichTextChunk[],
    context: string,
    options: { replyToAlreadyUsed?: boolean } = {},
  ): Promise<TelegramSendResult> => {
    const richRawApi = getTelegramRichRawApi(api);
    let lastMessageId = "";
    let lastChatId = chatId;
    let lastAcceptedParams:
      | TelegramThreadScopedParams
      | TelegramRichMessageContextParams
      | undefined;
    let acceptedReplyToMessageId: number | undefined;
    const messageIds: string[] = [];
    let sentChunkCount = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      const acceptedParams = buildRichTextParams(
        index,
        chunks.length,
        index === chunks.length - 1,
        options.replyToAlreadyUsed === true,
      );
      let result: TelegramMessageLike;
      let recordedParams: TelegramThreadScopedParams | TelegramRichMessageContextParams | undefined;
      if (isEmptyTelegramRichMessage(chunk.richMessage)) {
        // Gate on the rich payload only: valid rich content (media/divider HTML)
        // can have an empty plain projection and must still send.
        sendLogger.warn("telegram richMessage chunk rendered empty; skipping");
        continue;
      }
      try {
        warnTelegramRichBlocksDegradations({
          context: "richMessage",
          reasons: chunk.degradationReasons,
          warn: (message) => sendLogger.warn(message),
        });
        const richResult = await withTelegramNativeQuoteFallback<TelegramMessageLike>({
          label: "richMessage",
          requestParams: acceptedParams ?? {},
          removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
          request: (effectiveParams, retryLabel) =>
            requestWithChatNotFound(
              () =>
                richRawApi.sendRichMessage({
                  chat_id: chatId,
                  rich_message: chunk.richMessage,
                  ...effectiveParams,
                  ...(opts.silent === true ? { disable_notification: true } : {}),
                }),
              retryLabel,
            ),
        });
        result = richResult.result;
        recordedParams = toTelegramRichMessageContextParams(richResult.acceptedParams);
      } catch (err) {
        const fallbackPlan = buildTelegramPlainFallbackPlan({
          plainText: chunk.plainText,
          err,
          context: "richMessage",
          warn: (message) => sendLogger.warn(message),
        });
        if (!fallbackPlan) {
          throw err;
        }
        const fallbackChunks = fallbackPlan.chunks;
        const fallbackReplyChunkCount = Math.max(chunks.length, fallbackChunks.length);
        for (let fallbackIndex = 0; fallbackIndex < fallbackChunks.length; fallbackIndex += 1) {
          const fallbackText = fallbackChunks[fallbackIndex] ?? "";
          const fallbackReplyIndex = chunks.length === 1 ? fallbackIndex : index;
          const fallbackParams = buildTextParams(
            fallbackReplyIndex,
            fallbackReplyChunkCount,
            index === chunks.length - 1 && fallbackIndex === fallbackChunks.length - 1,
            options.replyToAlreadyUsed === true,
          );
          const plainResult = await sendTelegramTextChunk(
            { plainText: fallbackText },
            fallbackParams,
          );
          const fallbackMessageId = resolveTelegramMessageIdOrThrow(plainResult.result, context);
          recordSentMessage(chatId, fallbackMessageId, cfg);
          await reportDelivery(fallbackMessageId, plainResult.result?.chat?.id ?? chatId);
          await recordDeliveredPromptContext(
            {
              message: plainResult.result,
              messageId: fallbackMessageId,
              text: fallbackText,
              ...(plainResult.acceptedParams?.message_thread_id !== undefined
                ? { messageThreadId: plainResult.acceptedParams.message_thread_id }
                : {}),
            },
            index === chunks.length - 1 && fallbackIndex === fallbackChunks.length - 1,
          );
          lastMessageId = String(fallbackMessageId);
          lastChatId = String(plainResult.result?.chat?.id ?? chatId);
          lastAcceptedParams = plainResult.acceptedParams;
          acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(plainResult.acceptedParams);
          messageIds.push(lastMessageId);
          sentChunkCount += 1;
        }
        continue;
      }
      const messageId = resolveTelegramMessageIdOrThrow(result, context);
      recordSentMessage(chatId, messageId, cfg);
      await reportDelivery(messageId, result?.chat?.id ?? chatId);
      await recordDeliveredPromptContext(
        {
          message: result,
          messageId,
          text: chunk.plainText,
          ...(recordedParams?.message_thread_id !== undefined
            ? { messageThreadId: recordedParams.message_thread_id }
            : {}),
        },
        index === chunks.length - 1,
      );
      lastMessageId = String(messageId);
      lastChatId = String(result?.chat?.id ?? chatId);
      lastAcceptedParams = recordedParams;
      acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(recordedParams);
      messageIds.push(lastMessageId);
      sentChunkCount += 1;
    }
    if (lastMessageId) {
      logTelegramOutboundSendOk({
        accountId: account.accountId,
        chatId: lastChatId,
        messageId: lastMessageId,
        operation: "sendRichMessage",
        deliveryKind: "text",
        messageThreadId: lastAcceptedParams?.message_thread_id,
        replyToMessageId: opts.replyToMessageId,
        silent: opts.silent,
        chunkCount: sentChunkCount,
      });
    }
    const receipt = buildTelegramTextSendReceipt({
      messageIds,
      chatId: lastChatId,
      messageThreadId: lastAcceptedParams?.message_thread_id,
      replyToMessageId: acceptedReplyToMessageId,
    });
    return {
      messageId: lastMessageId,
      chatId: lastChatId,
      ...(receipt ? { receipt } : {}),
    };
  };

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

    let sendImageAsPhoto = true;
    const deliveryKind =
      opts.forceDocument === true && (kind === "image" || kind === "video") ? "document" : kind;
    if (opts.asVideoNote === true && deliveryKind !== "video") {
      throw new Error("Telegram video notes require video media.");
    }
    if (deliveryKind === "image" && !isGif) {
      sendImageAsPhoto = await shouldSendTelegramImageAsPhoto(media.buffer);
    }
    const isVideoNote = deliveryKind === "video" && opts.asVideoNote === true;
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
    const plainCaption =
      caption && textMode === "html" ? telegramHtmlToPlainTextFallback(caption) : caption;
    // If text exceeds Telegram's caption limit, send media without caption
    // then send text as a separate follow-up message.
    const needsSeparateText = Boolean(followUpText);
    // When splitting, put reply_markup only on the follow-up text (the "main" content),
    // not on the media message.
    const mediaThreadParams = buildThreadParams(true);
    const mediaUsedReplyTo = resolveAcceptedReplyToMessageId(mediaThreadParams) !== undefined;
    const baseMediaParams = {
      ...mediaThreadParams,
      ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    const videoDimensions =
      deliveryKind === "video" && !isVideoNote
        ? await probeVideoDimensions(media.buffer)
        : undefined;
    const mediaParams = {
      ...(htmlCaption ? { caption: htmlCaption, parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
      ...(videoDimensions ? { width: videoDimensions.width, height: videoDimensions.height } : {}),
    };
    const plainMediaParams = {
      ...(plainCaption ? { caption: plainCaption } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
      ...(videoDimensions ? { width: videoDimensions.width, height: videoDimensions.height } : {}),
    };
    const sendMedia = async (
      label: string,
      sender: (
        effectiveParams: TelegramThreadScopedParams | undefined,
      ) => Promise<TelegramMessageLike>,
    ) => {
      const requestMedia = (requestParams: TelegramThreadScopedParams, retryLabel: string) =>
        withTelegramNativeQuoteFallback({
          label: retryLabel,
          requestParams,
          request: (effectiveParams, effectiveLabel) =>
            requestWithChatNotFound(
              () => sender(effectiveParams as TelegramThreadScopedParams),
              effectiveLabel,
            ),
        });
      if (!htmlCaption || !plainCaption) {
        return await requestMedia(mediaParams, label);
      }
      // Same contract as text sends: Telegram HTML parse failures retry once
      // with the already visible plain caption so final media replies survive.
      return await withTelegramHtmlParseFallback({
        label,
        verbose: opts.verbose,
        requestHtml: (retryLabel) => requestMedia(mediaParams, retryLabel),
        requestPlain: (retryLabel) => requestMedia(plainMediaParams, retryLabel),
      });
    };

    const mediaSender = (() => {
      if (isGif && deliveryKind !== "document") {
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
      if (deliveryKind === "image" && !isGif && sendImageAsPhoto) {
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
      if (deliveryKind === "video") {
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
            (opts.forceDocument
              ? { ...effectiveParams, disable_content_type_detection: true }
              : effectiveParams) as Parameters<typeof api.sendDocument>[2],
          ) as Promise<TelegramMessageLike>,
      };
    })();

    let mediaDelivery: Awaited<ReturnType<typeof sendMedia>>;
    try {
      mediaDelivery = await sendMedia(mediaSender.label, mediaSender.sender);
    } catch (error) {
      opts.promptContextProjectionPlan?.cursor.invalidate();
      throw error;
    }
    const result = mediaDelivery.result;
    const acceptedMediaParams = toAcceptedThreadScopedParams(mediaDelivery.acceptedParams);
    const mediaMessageId = resolveTelegramMessageIdOrThrow(result, "media send");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    recordSentMessage(chatId, mediaMessageId, cfg);
    await reportDelivery(mediaMessageId, resolvedChatId);
    await recordDeliveredPromptContext(
      {
        message: result,
        messageId: mediaMessageId,
        ...(caption ? { text: caption } : {}),
        ...(acceptedMediaParams?.message_thread_id !== undefined
          ? { messageThreadId: acceptedMediaParams.message_thread_id }
          : {}),
      },
      !needsSeparateText,
    );
    logTelegramOutboundSendOk({
      accountId: account.accountId,
      chatId: resolvedChatId,
      messageId: String(mediaMessageId),
      operation: `send${mediaSender.label
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("")}`,
      deliveryKind: mediaSender.label,
      messageThreadId: acceptedMediaParams?.message_thread_id,
      replyToMessageId: opts.replyToMessageId,
      silent: opts.silent,
    });
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use HTML conversion so markdown renders like captions.
    if (needsSeparateText && followUpText) {
      const textResult = await sendChunkedText(followUpText, "text follow-up send", {
        replyToAlreadyUsed: singleUseReplyTo && mediaUsedReplyTo,
      });
      return {
        ...textResult,
        chatId: resolvedChatId,
      };
    }

    return { messageId: String(mediaMessageId), chatId: resolvedChatId };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const textResult = await sendChunkedText(text, "text send");
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return textResult;
}

/** Send a standalone location pin or named venue through Telegram's native payload. */
export async function sendLocationTelegram(
  to: string,
  input: OutboundLocation,
  opts: TelegramLocationSendOpts,
): Promise<TelegramSendResult> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    sendLocationTelegramWithContext(to, input, opts, context),
  );
}

async function sendLocationTelegramWithContext(
  to: string,
  input: OutboundLocation,
  opts: TelegramLocationSendOpts,
  context: TelegramApiContext,
): Promise<TelegramSendResult> {
  const location = normalizeOutboundLocation(input);
  if (!location) {
    throw new Error("Telegram location is required.");
  }
  const hasName = Boolean(location.name);
  const hasAddress = Boolean(location.address);
  if (hasName !== hasAddress) {
    throw new Error("Telegram venues require both location.name and location.address.");
  }

  const { cfg, account, api } = context;
  const botUserId = resolveTelegramBotUserIdFromToken(opts.token || account.token);
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
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
  const replyMarkup = buildInlineKeyboard(opts.buttons);
  const commonParams = {
    ...threadParams,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };
  const requestWithChatNotFound = createRequestWithChatNotFound({
    requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
      cfg,
      account,
      retry: opts.retry,
      verbose: opts.verbose,
    }),
    chatId,
    input: to,
  });
  const label = hasName ? "venue" : "location";
  const delivery = await withTelegramNativeQuoteFallback({
    label,
    requestParams: commonParams,
    request: (effectiveParams, retryLabel) =>
      requestWithChatNotFound(
        () =>
          hasName
            ? api.sendVenue(
                chatId,
                location.latitude,
                location.longitude,
                location.name ?? "",
                location.address ?? "",
                effectiveParams as TelegramSendVenueParams,
              )
            : api.sendLocation(chatId, location.latitude, location.longitude, {
                ...effectiveParams,
                ...(location.accuracy !== undefined
                  ? { horizontal_accuracy: location.accuracy }
                  : {}),
              } as TelegramSendLocationParams),
        retryLabel,
      ),
  });
  const result = delivery.result;
  const acceptedParams = toAcceptedThreadScopedParams(delivery.acceptedParams);
  const messageId = resolveTelegramMessageIdOrThrow(result, `${label} send`);
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  recordSentMessage(chatId, messageId, cfg);
  await opts.onDeliveryResult?.({ messageId: String(messageId), chatId: resolvedChatId });
  const projectionPlan = opts.promptContextProjectionPlan;
  const projection = projectionPlan?.cursor.take(projectionPlan.finalPart);
  const recorded = await recordOutboundMessageForPromptContext({
    cfg,
    account,
    ...(botUserId !== undefined ? { botUserId } : {}),
    chatId,
    message: result,
    messageId,
    text: formatLocationText(location),
    ...(acceptedParams?.message_thread_id !== undefined
      ? { messageThreadId: acceptedParams.message_thread_id }
      : {}),
    promptContextProjection: projection,
  });
  if (projection && !recorded) {
    projectionPlan?.cursor.invalidate();
  }
  logTelegramOutboundSendOk({
    accountId: account.accountId,
    chatId: resolvedChatId,
    messageId: String(messageId),
    operation: hasName ? "sendVenue" : "sendLocation",
    deliveryKind: label,
    messageThreadId: acceptedParams?.message_thread_id,
    replyToMessageId: opts.replyToMessageId,
    silent: opts.silent,
  });
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return { messageId: String(messageId), chatId: resolvedChatId };
}

export async function sendTypingTelegram(
  to: string,
  opts: TelegramTypingOpts,
): Promise<{ ok: true }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(context, sendTypingTelegramWithContext(to, opts, context));
}

async function sendTypingTelegramWithContext(
  to: string,
  opts: TelegramTypingOpts,
  context: TelegramApiContext,
): Promise<{ ok: true }> {
  const { cfg, account, api } = context;
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
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "action" }),
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
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    reactMessageTelegramWithContext(chatIdInput, messageIdInput, emoji, opts, context),
  );
}

async function reactMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: TelegramReactionOpts,
  context: TelegramApiContext,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "react" }),
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
  gatewayClientScopes?: readonly string[];
};

export async function deleteMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    deleteMessageTelegramWithContext(chatIdInput, messageIdInput, opts, context),
  );
}

async function deleteMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts,
  context: TelegramApiContext,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "delete" }),
  });
  try {
    await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage", {
      shouldLog: (err) => !isTelegramMessageDeleteNoopError(err),
    });
  } catch (err: unknown) {
    if (!isTelegramMessageDeleteNoopError(err)) {
      throw err;
    }
    const detail = formatErrorMessage(err);
    logVerbose(`[telegram] Delete skipped for message ${messageId} in chat ${chatId}: ${detail}`);
    return {
      ok: false,
      warning: `Message ${messageId} was not deleted: ${detail}`,
    };
  }
  logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
  return { ok: true };
}

export async function pinMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    pinMessageTelegramWithContext(chatIdInput, messageIdInput, opts, context),
  );
}

async function pinMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
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
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    unpinMessageTelegramWithContext(chatIdInput, messageIdInput, opts, context),
  );
}

async function unpinMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number | undefined,
  opts: TelegramDeleteOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; chatId: string; messageId?: string }> {
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
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

  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    editForumTopicTelegramWithContext(chatIdInput, messageThreadIdInput, opts, context),
  );
}

async function editForumTopicTelegramWithContext(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  opts: TelegramEditForumTopicOpts,
  context: TelegramApiContext,
): Promise<{
  ok: true;
  chatId: string;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
}> {
  const trimmedName = opts.name?.trim();
  const trimmedIconCustomEmojiId = opts.iconCustomEmojiId?.trim();
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const target = parseTelegramTarget(rawTarget);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
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
  gatewayClientScopes?: readonly string[];
  textMode?: "markdown" | "html";
  /** Controls whether link previews are shown in the edited message. */
  linkPreview?: boolean;
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons;
  /** Use Telegram's media-caption edit endpoint, or fall back to it when text edits target media. */
  editMode?: "text" | "caption" | "auto";
  /** Resolved runtime config from the command or gateway boundary. */
  cfg: OpenClawConfig;
};

type TelegramEditReplyMarkupOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
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
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    editMessageReplyMarkupTelegramWithContext(chatIdInput, messageIdInput, buttons, opts, context),
  );
}

async function editMessageReplyMarkupTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  buttons: TelegramInlineButtons,
  opts: TelegramEditReplyMarkupOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
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
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    editMessageTelegramWithContext(chatIdInput, messageIdInput, text, opts, context),
  );
}

async function editMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  text: string,
  opts: TelegramEditOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) =>
      isRecoverableTelegramNetworkError(err, { context: "edit" }) || isTelegramServerError(err),
  });
  const requestWithEditShouldLog = <T>(
    fn: () => Promise<T>,
    label?: string,
    shouldLog?: (err: unknown) => boolean,
  ) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : undefined);

  const textMode = opts.textMode ?? "markdown";
  // Caller-authored HTML edits keep legacy parse_mode HTML semantics too.
  const useRichMessages = account.config.richMessages === true && textMode !== "html";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    supportsBlockTables: useRichMessages,
  });
  const htmlText = renderTelegramHtmlText(text, { textMode, tableMode });
  const plainText = textMode === "html" ? telegramHtmlToPlainTextFallback(htmlText) : text;
  const richRawApi = useRichMessages ? getTelegramRichRawApi(api) : undefined;
  const richMessagePlan = useRichMessages
    ? buildTelegramRichMarkdownPlan(text, {
        skipEntityDetection: opts.linkPreview === false,
        tableMode,
      })
    : undefined;

  // Reply markup semantics:
  // - buttons === undefined → don't send reply_markup (keep existing)
  // - buttons is [] (or filters to empty) → send { inline_keyboard: [] } (remove)
  // - otherwise → send built inline keyboard
  const shouldTouchButtons = opts.buttons !== undefined;
  const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : undefined;
  const replyMarkup = shouldTouchButtons ? (builtKeyboard ?? { inline_keyboard: [] }) : undefined;

  const textEditParams: TelegramEditMessageTextParams = {
    parse_mode: "HTML",
  };
  if (opts.linkPreview === false) {
    textEditParams.link_preview_options = { is_disabled: true };
  }
  if (replyMarkup !== undefined) {
    textEditParams.reply_markup = replyMarkup;
  }
  const plainTextParams: TelegramEditMessageTextParams = {};
  if (opts.linkPreview === false) {
    plainTextParams.link_preview_options = { is_disabled: true };
  }
  if (replyMarkup !== undefined) {
    plainTextParams.reply_markup = replyMarkup;
  }
  const captionEditParams: TelegramEditMessageCaptionParams = {
    caption: htmlText,
    parse_mode: "HTML",
  };
  if (replyMarkup !== undefined) {
    captionEditParams.reply_markup = replyMarkup;
  }
  const plainCaptionParams: TelegramEditMessageCaptionParams = {
    caption: plainText,
  };
  if (replyMarkup !== undefined) {
    plainCaptionParams.reply_markup = replyMarkup;
  }

  const performTextEdit = () => {
    if (richRawApi && richMessagePlan) {
      const richEditParams: Pick<TelegramEditRichMessageTextParams, "reply_markup"> =
        replyMarkup === undefined ? {} : { reply_markup: replyMarkup };
      warnTelegramRichBlocksDegradations({
        context: "editMessage",
        reasons: richMessagePlan.degradationReasons,
        warn: (message) => sendLogger.warn(message),
      });
      return requestWithEditShouldLog(
        () =>
          richRawApi.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            rich_message: richMessagePlan.richMessage,
            ...richEditParams,
          }),
        "editMessage",
        (err) => !isTelegramMessageNotModifiedError(err),
      ).catch((err: unknown) => {
        const fallbackPlan = buildTelegramPlainFallbackPlan({
          plainText: richMessagePlan.plainText,
          err,
          context: "editMessage",
          warn: (message) => sendLogger.warn(message),
        });
        if (!fallbackPlan) {
          throw err;
        }
        return requestWithEditShouldLog(
          () =>
            Object.keys(plainTextParams).length > 0
              ? api.editMessageText(chatId, messageId, fallbackPlan.plainText, plainTextParams)
              : api.editMessageText(chatId, messageId, fallbackPlan.plainText),
          "editMessage-plain",
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        );
      });
    }
    return withTelegramHtmlParseFallback({
      label: "editMessage",
      verbose: opts.verbose,
      requestHtml: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageText(chatId, messageId, htmlText, textEditParams),
          retryLabel,
          (err) => !isTelegramMessageNotModifiedError(err),
        ),
      requestPlain: (retryLabel) =>
        requestWithEditShouldLog(
          () =>
            Object.keys(plainTextParams).length > 0
              ? api.editMessageText(chatId, messageId, plainText, plainTextParams)
              : api.editMessageText(chatId, messageId, plainText),
          retryLabel,
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        ),
    });
  };

  const performCaptionEdit = () =>
    withTelegramHtmlParseFallback({
      label: "editMessageCaption",
      verbose: opts.verbose,
      requestHtml: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageCaption(chatId, messageId, captionEditParams),
          retryLabel,
          (err) => !isTelegramMessageNotModifiedError(err),
        ),
      requestPlain: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageCaption(chatId, messageId, plainCaptionParams),
          retryLabel,
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        ),
    });

  try {
    const editMode = opts.editMode ?? "text";
    if (editMode === "caption") {
      await performCaptionEdit();
    } else {
      try {
        await performTextEdit();
      } catch (err) {
        if (editMode === "auto" && isTelegramMessageHasNoTextError(err)) {
          await performCaptionEdit();
        } else {
          throw err;
        }
      }
    }
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
  gatewayClientScopes?: readonly string[];
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

  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    sendStickerTelegramWithContext(to, fileId, opts, context),
  );
}

async function sendStickerTelegramWithContext(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts,
  context: TelegramApiContext,
): Promise<TelegramSendResult> {
  const { cfg, account, api } = context;
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
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

  const result = await requestWithChatNotFound(
    () => api.sendSticker(chatId, fileId.trim(), stickerParams),
    "sticker",
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
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(context, sendPollTelegramWithContext(to, poll, opts, context));
}

async function sendPollTelegramWithContext(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts,
  context: TelegramApiContext,
): Promise<{ messageId: string; chatId: string; pollId?: string }> {
  const { cfg, account, api } = context;
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
  const normalizedPoll = normalizePollInput(poll, { maxOptions: 12 });

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

  const result = await requestWithChatNotFound(
    () => api.sendPoll(chatId, normalizedPoll.question, pollOptions, pollParams),
    "poll",
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
  gatewayClientScopes?: readonly string[];
  /** Icon color for the topic (must be one of 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F). */
  iconColor?: TelegramCreateForumTopicParams["icon_color"];
  /** Custom emoji ID for the topic icon. */
  iconCustomEmojiId?: string;
};

type TelegramCreateForumTopicResult = {
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

  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    createForumTopicTelegramWithContext(chatId, name, opts, context),
  );
}

async function createForumTopicTelegramWithContext(
  chatId: string,
  name: string,
  opts: TelegramCreateForumTopicOpts,
  context: TelegramApiContext,
): Promise<TelegramCreateForumTopicResult> {
  const trimmedName = name.trim();
  const { cfg, account, api } = context;
  // Accept topic-qualified targets (e.g. telegram:group:<id>:topic:<thread>)
  // but createForumTopic must always target the base supergroup chat id.
  const target = parseTelegramTarget(chatId);
  const normalizedChatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: chatId,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
