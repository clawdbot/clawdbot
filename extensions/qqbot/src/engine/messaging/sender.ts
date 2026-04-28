/**
 * Unified message sender — per-account resource management + business function layer.
 *
 * This module is the **single entry point** for all QQ Bot API operations.
 *
 * ## Architecture
 *
 * Each account gets its own isolated resource stack:
 *
 * ```
 * _accountRegistry: Map<appId, AccountContext>
 *
 * AccountContext {
 *   logger      — per-account prefixed logger
 *   client      — per-account ApiClient
 *   tokenMgr    — per-account TokenManager
 *   mediaApi    — per-account MediaApi
 *   messageApi  — per-account MessageApi
 * }
 * ```
 *
 * Upper-layer callers (gateway, outbound, reply-dispatcher, proactive)
 * always go through exported functions that resolve the correct
 * `AccountContext` by appId.
 */

import os from "node:os";
import { ApiClient } from "../api/api-client.js";
import { ChunkedMediaApi as ChunkedMediaApiClass } from "../api/media-chunked.js";
import { MediaApi as MediaApiClass } from "../api/media.js";
import type { Credentials } from "../api/messages.js";
import { MessageApi as MessageApiClass } from "../api/messages.js";
import { getNextMsgSeq } from "../api/routes.js";
import { TokenManager } from "../api/token.js";
import {
  ApiError,
  MediaFileType,
  type ChatScope,
  type EngineLogger,
  type MessageResponse,
  type OutboundMeta,
  type UploadMediaResponse,
} from "../types.js";
import { LARGE_FILE_THRESHOLD } from "../utils/file-utils.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError, debugWarn } from "../utils/log.js";
import { sanitizeFileName } from "../utils/string-normalize.js";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "../utils/upload-cache.js";
import { normalizeSource, type MediaSource, type RawMediaSource } from "./media-source.js";

// ============ Re-exported types ============

export { ApiError } from "../types.js";
export type { OutboundMeta, MessageResponse, UploadMediaResponse } from "../types.js";
export { MediaFileType } from "../types.js";
export { UploadDailyLimitExceededError } from "../api/media-chunked.js";

// ============ Plugin User-Agent ============

let _pluginVersion = "unknown";
let _openclawVersion = "unknown";

/** Build the User-Agent string from the current plugin and framework versions. */
function buildUserAgent(): string {
  return `QQBotPlugin/${_pluginVersion} (Node/${process.versions.node}; ${os.platform()}; OpenClaw/${_openclawVersion})`;
}

/** Return the current User-Agent string. */
export function getPluginUserAgent(): string {
  return buildUserAgent();
}

/**
 * Initialize sender with the plugin version.
 * Must be called once during startup before any API calls.
 */
export function initSender(options: { pluginVersion?: string; openclawVersion?: string }): void {
  if (options.pluginVersion) {
    _pluginVersion = options.pluginVersion;
  }
  if (options.openclawVersion) {
    _openclawVersion = options.openclawVersion;
  }
}

/** Update the OpenClaw framework version in the User-Agent (called after runtime injection). */
export function setOpenClawVersion(version: string): void {
  if (version) {
    _openclawVersion = version;
  }
}

// ============ Per-account resource management ============

/** Complete resource context for a single account. */
interface AccountContext {
  logger: EngineLogger;
  client: ApiClient;
  tokenMgr: TokenManager;
  mediaApi: MediaApiClass;
  chunkedMediaApi: ChunkedMediaApiClass;
  messageApi: MessageApiClass;
  markdownSupport: boolean;
}

/** Per-appId account registry — each account owns all its resources. */
const _accountRegistry = new Map<string, AccountContext>();

/** Fallback logger for unregistered accounts (CLI / test scenarios). */
const _fallbackLogger: EngineLogger = {
  info: (msg: string) => debugLog(msg),
  error: (msg: string) => debugError(msg),
  warn: (msg: string) => debugWarn(msg),
  debug: (msg: string) => debugLog(msg),
};

/**
 * Build a full resource stack for a given logger.
 *
 * Shared by both `registerAccount` (explicit registration) and
 * `resolveAccount` (lazy fallback for unregistered accounts).
 */
function buildAccountContext(logger: EngineLogger, markdownSupport: boolean): AccountContext {
  const client = new ApiClient({ logger, userAgent: buildUserAgent });
  const tokenMgr = new TokenManager({ logger, userAgent: buildUserAgent });
  // The one-shot and chunked uploaders share the same cache adapter so repeat
  // sends of identical bytes hit the same `file_info` regardless of which
  // path the first send used.
  const sharedUploadCache = {
    computeHash: computeFileHash,
    get: (hash: string, scope: string, targetId: string, fileType: number) =>
      getCachedFileInfo(hash, scope as ChatScope, targetId, fileType),
    set: (
      hash: string,
      scope: string,
      targetId: string,
      fileType: number,
      fileInfo: string,
      fileUuid: string,
      ttl: number,
    ) => setCachedFileInfo(hash, scope as ChatScope, targetId, fileType, fileInfo, fileUuid, ttl),
  };
  const mediaApi = new MediaApiClass(client, tokenMgr, {
    logger,
    uploadCache: sharedUploadCache,
    sanitizeFileName,
  });
  const chunkedMediaApi = new ChunkedMediaApiClass(client, tokenMgr, {
    logger,
    uploadCache: sharedUploadCache,
    sanitizeFileName,
  });
  const messageApi = new MessageApiClass(client, tokenMgr, {
    markdownSupport,
    logger,
  });

  return { logger, client, tokenMgr, mediaApi, chunkedMediaApi, messageApi, markdownSupport };
}

/**
 * Register an account — atomically sets up all per-appId resources.
 *
 * Must be called once per account during gateway startup.
 * Creates a complete isolated resource stack (ApiClient, TokenManager,
 * MediaApi, MessageApi) with the per-account logger.
 */
export function registerAccount(
  appId: string,
  options: {
    logger: EngineLogger;
    markdownSupport?: boolean;
  },
): void {
  const key = appId.trim();
  const md = options.markdownSupport === true;
  _accountRegistry.set(key, buildAccountContext(options.logger, md));
}

/**
 * Initialize per-app API behavior such as markdown support.
 *
 * If the account was already registered via `registerAccount()`, updates its
 * MessageApi with the new markdown setting while preserving the existing
 * logger and resource stack. Otherwise creates a new context.
 */
export function initApiConfig(appId: string, options: { markdownSupport?: boolean }): void {
  const key = appId.trim();
  const md = options.markdownSupport === true;
  const existing = _accountRegistry.get(key);
  if (existing) {
    // Re-create only MessageApi with updated config, reuse existing stack.
    existing.messageApi = new MessageApiClass(existing.client, existing.tokenMgr, {
      markdownSupport: md,
      logger: existing.logger,
    });
    existing.markdownSupport = md;
  } else {
    _accountRegistry.set(key, buildAccountContext(_fallbackLogger, md));
  }
}

/**
 * Resolve the AccountContext for a given appId.
 *
 * If the account was registered via `registerAccount()`, returns the
 * pre-built context. Otherwise lazily creates a fallback context.
 */
function resolveAccount(appId: string): AccountContext {
  const key = appId.trim();
  let ctx = _accountRegistry.get(key);
  if (!ctx) {
    ctx = buildAccountContext(_fallbackLogger, false);
    _accountRegistry.set(key, ctx);
  }
  return ctx;
}

// ============ Instance getters (for advanced callers) ============

/** Get the MessageApi instance for the given appId. */
export function getMessageApi(appId: string): MessageApiClass {
  return resolveAccount(appId).messageApi;
}

/** Get the MediaApi instance for the given appId. */
export function getMediaApi(appId: string): MediaApiClass {
  return resolveAccount(appId).mediaApi;
}

/** Get the ChunkedMediaApi instance for the given appId. */
export function getChunkedMediaApi(appId: string): ChunkedMediaApiClass {
  return resolveAccount(appId).chunkedMediaApi;
}

/** Get the TokenManager instance for the given appId. */
export function getTokenManager(appId: string): TokenManager {
  return resolveAccount(appId).tokenMgr;
}

/** Get the ApiClient instance for the given appId. */
export function getApiClient(appId: string): ApiClient {
  return resolveAccount(appId).client;
}

// ============ Per-appId config ============

type OnMessageSentCallback = (refIdx: string, meta: OutboundMeta) => void;

/** Register an outbound-message hook scoped to one appId. */
export function onMessageSent(appId: string, callback: OnMessageSentCallback): void {
  resolveAccount(appId).messageApi.onMessageSent(callback);
}

/** Return whether markdown is enabled for the given appId. */
export function isMarkdownSupport(appId: string): boolean {
  return _accountRegistry.get(appId.trim())?.markdownSupport ?? false;
}

// ============ Token management ============

export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  return resolveAccount(appId).tokenMgr.getAccessToken(appId, clientSecret);
}

export function clearTokenCache(appId?: string): void {
  if (appId) {
    resolveAccount(appId).tokenMgr.clearCache(appId);
  } else {
    for (const ctx of _accountRegistry.values()) {
      ctx.tokenMgr.clearCache();
    }
  }
}

export function getTokenStatus(appId: string): {
  status: "valid" | "expired" | "refreshing" | "none";
  expiresAt: number | null;
} {
  return resolveAccount(appId).tokenMgr.getStatus(appId);
}

export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: {
    refreshAheadMs?: number;
    randomOffsetMs?: number;
    minRefreshIntervalMs?: number;
    retryDelayMs?: number;
    log?: {
      info: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
  },
): void {
  resolveAccount(appId).tokenMgr.startBackgroundRefresh(appId, clientSecret, options);
}

export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId) {
    resolveAccount(appId).tokenMgr.stopBackgroundRefresh(appId);
  } else {
    for (const ctx of _accountRegistry.values()) {
      ctx.tokenMgr.stopBackgroundRefresh();
    }
  }
}

export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  if (appId) {
    return resolveAccount(appId).tokenMgr.isBackgroundRefreshRunning(appId);
  }
  for (const ctx of _accountRegistry.values()) {
    if (ctx.tokenMgr.isBackgroundRefreshRunning()) {
      return true;
    }
  }
  return false;
}

// ============ Gateway URL ============

export async function getGatewayUrl(accessToken: string, appId: string): Promise<string> {
  const data = await resolveAccount(appId).client.request<{ url: string }>(
    accessToken,
    "GET",
    "/gateway",
  );
  return data.url;
}

// ============ Interaction ============

/** Acknowledge an INTERACTION_CREATE event via PUT /interactions/{id}. */
export async function acknowledgeInteraction(
  creds: AccountCreds,
  interactionId: string,
  code: 0 | 1 | 2 | 3 | 4 | 5 = 0,
  data?: Record<string, unknown>,
): Promise<void> {
  const ctx = resolveAccount(creds.appId);
  const token = await ctx.tokenMgr.getAccessToken(creds.appId, creds.clientSecret);
  await ctx.client.request(token, "PUT", `/interactions/${interactionId}`, {
    code,
    ...(data ? { data } : {}),
  });
}

// ============ Types ============

/** Delivery target resolved from event context. */
export interface DeliveryTarget {
  type: "c2c" | "group" | "channel" | "dm";
  id: string;
}

/** Account credentials for API authentication. */
export interface AccountCreds {
  appId: string;
  clientSecret: string;
}

// ============ Token retry ============

/**
 * Execute an API call with automatic token-retry on 401 errors.
 *
 * Primary signal is structured: `ApiError.httpStatus === 401`. A string
 * fallback remains for non-`ApiError` paths (e.g. synthetic errors from
 * custom adapters), but logs a warning so such cases can be surfaced.
 */
export async function withTokenRetry<T>(
  creds: AccountCreds,
  sendFn: (token: string) => Promise<T>,
  log?: EngineLogger,
  _accountId?: string,
): Promise<T> {
  try {
    const token = await getAccessToken(creds.appId, creds.clientSecret);
    return await sendFn(token);
  } catch (err) {
    const isStructured401 = err instanceof ApiError && err.httpStatus === 401;
    if (isStructured401) {
      log?.debug?.(`Token expired (ApiError 401), refreshing...`);
      clearTokenCache(creds.appId);
      const newToken = await getAccessToken(creds.appId, creds.clientSecret);
      return await sendFn(newToken);
    }

    // String fallback — retain for non-ApiError code paths but make it visible.
    const errMsg = formatErrorMessage(err);
    const looksLike401 =
      errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token");
    if (looksLike401) {
      log?.warn?.(
        `Token retry triggered by string heuristic (err is not ApiError). ` +
          `Consider propagating ApiError end-to-end. msg=${errMsg.slice(0, 120)}`,
      );
      clearTokenCache(creds.appId);
      const newToken = await getAccessToken(creds.appId, creds.clientSecret);
      return await sendFn(newToken);
    }
    throw err;
  }
}

// ============ Media hook helper ============

/**
 * Notify the MessageApi onMessageSent hook after a media send.
 */
function notifyMediaHook(appId: string, result: MessageResponse, meta: OutboundMeta): void {
  const refIdx = result.ext_info?.ref_idx;
  if (refIdx) {
    resolveAccount(appId).messageApi.notifyMessageSent(refIdx, meta);
  }
}

// ============ Text sending ============

/**
 * Send a text message to any QQ target type.
 *
 * Automatically routes to the correct API method based on target type.
 * Handles passive (with msgId) and proactive (without msgId) modes.
 */
export async function sendText(
  target: DeliveryTarget,
  content: string,
  creds: AccountCreds,
  opts?: { msgId?: string; messageReference?: string },
): Promise<MessageResponse> {
  const api = resolveAccount(creds.appId).messageApi;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  if (target.type === "c2c" || target.type === "group") {
    const scope: ChatScope = target.type;
    if (opts?.msgId) {
      return api.sendMessage(scope, target.id, content, c, {
        msgId: opts.msgId,
        messageReference: opts.messageReference,
      });
    }
    return api.sendProactiveMessage(scope, target.id, content, c);
  }

  if (target.type === "dm") {
    return api.sendDmMessage({ guildId: target.id, content, creds: c, msgId: opts?.msgId });
  }

  return api.sendChannelMessage({ channelId: target.id, content, creds: c, msgId: opts?.msgId });
}

/**
 * Send text with automatic token-retry.
 */
export async function sendTextWithRetry(
  target: DeliveryTarget,
  content: string,
  creds: AccountCreds,
  opts?: { msgId?: string; messageReference?: string },
  log?: EngineLogger,
): Promise<MessageResponse> {
  return withTokenRetry(
    creds,
    async () => sendText(target, content, creds, opts),
    log,
    creds.appId,
  );
}

/**
 * Send a proactive text message (no msgId).
 */
export async function sendProactiveText(
  target: DeliveryTarget,
  content: string,
  creds: AccountCreds,
): Promise<MessageResponse> {
  return sendText(target, content, creds);
}

// ============ Input notify ============

/**
 * Send a typing indicator to a C2C user.
 */
export async function sendInputNotify(opts: {
  openid: string;
  creds: AccountCreds;
  msgId?: string;
  inputSecond?: number;
}): Promise<{ refIdx?: string }> {
  const api = resolveAccount(opts.creds.appId).messageApi;
  const c: Credentials = { appId: opts.creds.appId, clientSecret: opts.creds.clientSecret };
  return api.sendInputNotify({
    openid: opts.openid,
    creds: c,
    msgId: opts.msgId,
    inputSecond: opts.inputSecond,
  });
}

/**
 * Raw-token input notify — compatible with TypingKeepAlive's callback signature.
 */
export function createRawInputNotifyFn(
  appId: string,
): (
  token: string,
  openid: string,
  msgId: string | undefined,
  inputSecond: number,
) => Promise<unknown> {
  return async (token, openid, msgId, inputSecond) => {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    return resolveAccount(appId).client.request(token, "POST", `/v2/users/${openid}/messages`, {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: inputSecond },
      msg_seq: msgSeq,
      ...(msgId ? { msg_id: msgId } : {}),
    });
  };
}

// ============ Media sending (unified) ============

/** Rich-media kind accepted by {@link sendMedia}. */
export type MediaKind = "image" | "voice" | "video" | "file";

/** Map a {@link MediaKind} to the wire-level {@link MediaFileType} code. */
const KIND_TO_FILE_TYPE: Record<MediaKind, MediaFileType> = {
  image: MediaFileType.IMAGE,
  voice: MediaFileType.VOICE,
  video: MediaFileType.VIDEO,
  file: MediaFileType.FILE,
};

/** Re-export source types so callers can construct them without importing media-source. */
export type { MediaSource, RawMediaSource } from "./media-source.js";

/**
 * Options for the unified {@link sendMedia} API.
 *
 * This replaces the legacy four-method surface
 * (`sendImage / sendVoiceMessage / sendVideoMessage / sendFileMessage`).
 */
export interface SendMediaOptions {
  /** Delivery target. Only `c2c` and `group` support rich media. */
  target: DeliveryTarget;
  /** Account credentials. */
  creds: AccountCreds;
  /** Media kind (drives `file_type`, meta, and content semantics). */
  kind: MediaKind;
  /** Media source — URL, base64, on-disk path, or in-memory buffer. */
  source: RawMediaSource;
  /** Passive reply message ID; omit for proactive sends. */
  msgId?: string;
  /**
   * Accompanying text. Only honored for `image` / `video` kinds — the QQ
   * API ignores it for voice/file.
   */
  content?: string;
  /** Override the server-visible file name (FILE kind only). */
  fileName?: string;
  /** Original TTS text — recorded in {@link OutboundMeta.ttsText} for voice. */
  ttsText?: string;
  /**
   * Local path to record in {@link OutboundMeta.mediaLocalPath}. Usually set
   * by adapters that already downloaded the source to disk; otherwise
   * inferred automatically when `source` is `{ localPath }`.
   */
  localPathForMeta?: string;
  /**
   * Original URL to record in {@link OutboundMeta.mediaUrl}. Usually set by
   * adapters that downloaded a remote URL before uploading; otherwise
   * inferred automatically when `source` is `{ url }` (non-data URL).
   */
  origUrlForMeta?: string;
}

/**
 * Upload and send a rich-media message to any C2C or Group target.
 *
 * This is the **single** rich-media entry point for the plugin. All adapter
 * layers (outbound.ts, reply-dispatcher.ts, outbound-deliver.ts,
 * bridge/commands, gateway/outbound-dispatch.ts) funnel through here.
 *
 * Dispatch structure:
 *
 * ```
 * sendMedia(opts)
 *   └─ sendMediaInternal(ctx, opts)
 *        ├─ normalizeSource  ← unified data:URL parsing + O_NOFOLLOW file safety
 *        ├─ uploadOnce       ← one-shot upload via MediaApi (chunked hook TBD)
 *        ├─ sendMediaMessage
 *        └─ notifyMediaHook  ← meta assembled per kind
 * ```
 *
 * Future chunked upload will slot into the dispatch without touching callers.
 */
export async function sendMedia(opts: SendMediaOptions): Promise<MessageResponse> {
  if (!supportsRichMedia(opts.target.type)) {
    throw new Error(`Media sending not supported for target type: ${opts.target.type}`);
  }
  const ctx = resolveAccount(opts.creds.appId);
  return sendMediaInternal(ctx, opts);
}

/**
 * Assemble an {@link OutboundMeta} record from the normalized source and the
 * caller-provided overrides.
 *
 * The meta layout is identical across kinds except:
 * - `image` / `video` carry `text` (the accompanying content string).
 * - `voice` carries `ttsText` (original TTS input, if any).
 */
function buildOutboundMeta(opts: SendMediaOptions, source: MediaSource): OutboundMeta {
  const meta: OutboundMeta = {
    mediaType: opts.kind,
  };

  if (opts.kind === "image" || opts.kind === "video") {
    if (opts.content) {
      meta.text = opts.content;
    }
  }
  if (opts.kind === "voice" && opts.ttsText) {
    meta.ttsText = opts.ttsText;
  }

  // Prefer explicit caller overrides; otherwise derive from the source.
  const inferredUrl = source.kind === "url" ? source.url : undefined;
  const mediaUrl = opts.origUrlForMeta ?? inferredUrl;
  if (mediaUrl) {
    meta.mediaUrl = mediaUrl;
  }

  const inferredLocal = source.kind === "localPath" ? source.path : undefined;
  const mediaLocalPath = opts.localPathForMeta ?? inferredLocal;
  if (mediaLocalPath) {
    meta.mediaLocalPath = mediaLocalPath;
  }

  return meta;
}

/**
 * Core dispatch for rich media. Not exported — callers must go through
 * {@link sendMedia}.
 *
 * Upload dispatch lives in {@link dispatchUpload}: sources smaller than
 * {@link LARGE_FILE_THRESHOLD} (or not supporting chunked transport, i.e.
 * url/base64) go to {@link MediaApi.uploadMedia}; larger `localPath` /
 * `buffer` sources go to {@link ChunkedMediaApi.uploadChunked}.
 */
async function sendMediaInternal(
  ctx: AccountContext,
  opts: SendMediaOptions,
): Promise<MessageResponse> {
  const scope: ChatScope = opts.target.type as ChatScope;
  const c: Credentials = {
    appId: opts.creds.appId,
    clientSecret: opts.creds.clientSecret,
  };

  // The outbound layer enforces per-file-type ceilings; normalizeSource's
  // default is the smaller one-shot limit. We pass the chunked limit here
  // to let the dispatcher decide per source.size whether to route to the
  // chunked uploader. Upstream (outbound/sendPhoto etc.) remains the
  // authoritative size-by-file-type gate.
  const source = await normalizeSource(opts.source, {
    maxSize: Number.MAX_SAFE_INTEGER,
  });

  const uploadResult = await dispatchUpload(
    ctx,
    scope,
    opts.target.id,
    KIND_TO_FILE_TYPE[opts.kind],
    source,
    c,
    opts.fileName,
  );

  // Content is semantically meaningful only for image / video — the voice
  // and file APIs ignore it.
  const msgContent = opts.kind === "image" || opts.kind === "video" ? opts.content : undefined;

  const result = await ctx.mediaApi.sendMediaMessage(
    scope,
    opts.target.id,
    uploadResult.file_info,
    c,
    {
      msgId: opts.msgId,
      content: msgContent,
    },
  );

  notifyMediaHook(opts.creds.appId, result, buildOutboundMeta(opts, source));
  return result;
}

/**
 * Upload a {@link MediaSource} via the one-shot or chunked path, chosen by
 * size + kind.
 *
 * Routing rules (kept here as the single source of truth so callers need
 * not know which endpoint was used):
 *
 * - `url` / `base64`: always one-shot — the server accepts these directly
 *   and the chunked endpoint has no representation for them.
 * - `localPath` / `buffer` with `size >= LARGE_FILE_THRESHOLD`: chunked.
 * - Everything else: one-shot.
 */
async function dispatchUpload(
  ctx: AccountContext,
  scope: ChatScope,
  targetId: string,
  fileType: MediaFileType,
  source: MediaSource,
  creds: Credentials,
  fileName?: string,
): Promise<UploadMediaResponse> {
  switch (source.kind) {
    case "url":
      return ctx.mediaApi.uploadMedia(scope, targetId, fileType, creds, {
        url: source.url,
        fileName,
      });
    case "base64":
      return ctx.mediaApi.uploadMedia(scope, targetId, fileType, creds, {
        fileData: source.data,
        fileName,
      });
    case "localPath":
      if (source.size >= LARGE_FILE_THRESHOLD) {
        return ctx.chunkedMediaApi.uploadChunked({
          scope,
          targetId,
          fileType,
          source,
          creds,
          fileName,
        });
      }
      return ctx.mediaApi.uploadMedia(scope, targetId, fileType, creds, {
        localPath: source.path,
        fileName,
      });
    case "buffer":
      if (source.buffer.length >= LARGE_FILE_THRESHOLD) {
        return ctx.chunkedMediaApi.uploadChunked({
          scope,
          targetId,
          fileType,
          source,
          creds,
          fileName: fileName ?? source.fileName,
        });
      }
      return ctx.mediaApi.uploadMedia(scope, targetId, fileType, creds, {
        buffer: source.buffer,
        fileName: fileName ?? source.fileName,
      });
    default: {
      const _exhaustive: never = source;
      throw new Error(
        `dispatchUpload: unsupported MediaSource kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

// ============ Helpers ============

/** Build a DeliveryTarget from event context fields. */
export function buildDeliveryTarget(event: {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
}): DeliveryTarget {
  switch (event.type) {
    case "c2c":
      return { type: "c2c", id: event.senderId };
    case "group":
      return { type: "group", id: event.groupOpenid! };
    case "dm":
      return { type: "dm", id: event.guildId! };
    default:
      return { type: "channel", id: event.channelId! };
  }
}

/** Build AccountCreds from a GatewayAccount. */
export function accountToCreds(account: { appId: string; clientSecret: string }): AccountCreds {
  return { appId: account.appId, clientSecret: account.clientSecret };
}

/** Check whether a target type supports rich media (C2C and Group only). */
export function supportsRichMedia(targetType: string): boolean {
  return targetType === "c2c" || targetType === "group";
}
