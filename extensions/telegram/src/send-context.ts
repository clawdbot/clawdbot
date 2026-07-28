import { type ApiClientOptions, Bot, HttpError } from "grammy";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import { formatUncaughtError } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { createChannelApiRetryRunner, type RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport, type TelegramTransport } from "./fetch.js";
import { isSafeToRetrySendError, isTelegramRateLimitError } from "./network-errors.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import { makeProxyFetch } from "./proxy.js";
import {
  getTelegramNativeQuoteReplyMessageId,
  isTelegramQuoteParamError,
  removeTelegramNativeQuoteParam,
} from "./reply-parameters.js";
import { TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS } from "./retry-after.js";
import type { TelegramRichMessageContextParams } from "./rich-message.js";
import { isTelegramHtmlParseError } from "./rich-plain-fallback.js";
import { requireRuntimeConfig, type OpenClawConfig } from "./send.runtime.js";
import { maybePersistResolvedTelegramTarget } from "./target-writeback.js";
import { normalizeTelegramChatId, normalizeTelegramLookupTarget } from "./targets.js";

export type TelegramApi = Bot["api"];
export type TelegramApiOverride = Partial<TelegramApi>;
export type TelegramThreadScopedParams = {
  message_thread_id?: number;
  reply_parameters?: { message_id?: number };
  reply_to_message_id?: number;
};
export function resolveTelegramMessageIdOrThrow(
  result: TelegramMessageLike | null | undefined,
  context: string,
): number {
  if (typeof result?.message_id === "number" && Number.isFinite(result.message_id)) {
    return Math.trunc(result.message_id);
  }
  throw new Error(`Telegram ${context} returned no message_id`);
}

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

export function logTelegramOutboundSendOk(params: TelegramOutboundSuccessLogParams): void {
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

export function resolveAcceptedReplyToMessageId(
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

export function toAcceptedThreadScopedParams(
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
export const sendLogger = createSubsystemLogger("telegram/send");
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
  const timeoutSeconds = undefined;

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

export async function resolveAndPersistChatId(params: {
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

export function normalizeMessageId(raw: string | number): number {
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

export function isTelegramMessageNotModifiedError(err: unknown): boolean {
  return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}

export function isTelegramMessageHasNoTextError(err: unknown): boolean {
  return MESSAGE_HAS_NO_TEXT_RE.test(formatErrorMessage(err));
}

export function isTelegramMessageDeleteNoopError(err: unknown): boolean {
  return MESSAGE_DELETE_NOOP_RE.test(formatErrorMessage(err));
}

export async function withTelegramHtmlParseFallback<T>(params: {
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

export async function withTelegramNativeQuoteFallback<T>(params: {
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

export type TelegramApiContext = {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
  clientOptionsLease?: TelegramClientOptionsLease | undefined;
};

export function resolveTelegramApiContext(opts: {
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

export function withTelegramApiContextLease<T>(
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

export function createTelegramRequestWithDiag(params: {
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
  const request = createChannelApiRetryRunner({
    retry: params.retry,
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

export function createRequestWithChatNotFound(params: {
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

export function createTelegramNonIdempotentRequestWithDiag(params: {
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
