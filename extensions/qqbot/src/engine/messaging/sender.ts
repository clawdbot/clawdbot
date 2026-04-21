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
import { MediaApi as MediaApiClass } from "../api/media.js";
import type { Credentials } from "../api/messages.js";
import { MessageApi as MessageApiClass } from "../api/messages.js";
import { getNextMsgSeq } from "../api/routes.js";
import { TokenManager } from "../api/token.js";
import {
  MediaFileType,
  type ChatScope,
  type EngineLogger,
  type MessageResponse,
  type OutboundMeta,
} from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError, debugWarn } from "../utils/log.js";
import { sanitizeFileName } from "../utils/string-normalize.js";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "../utils/upload-cache.js";

// ============ Re-exported types ============

export { ApiError } from "../types.js";
export type { OutboundMeta, MessageResponse, UploadMediaResponse } from "../types.js";
export { MediaFileType } from "../types.js";

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
  const mediaApi = new MediaApiClass(client, tokenMgr, {
    logger,
    uploadCache: {
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
    },
    sanitizeFileName,
  });
  const messageApi = new MessageApiClass(client, tokenMgr, {
    markdownSupport,
    logger,
  });

  return { logger, client, tokenMgr, mediaApi, messageApi, markdownSupport };
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
): Promise<void> {
  const ctx = resolveAccount(creds.appId);
  const token = await ctx.tokenMgr.getAccessToken(creds.appId, creds.clientSecret);
  await ctx.client.request(token, "PUT", `/interactions/${interactionId}`, { code });
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
    const errMsg = formatErrorMessage(err);
    if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
      log?.debug?.(`Token may be expired, refreshing...`);
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

// ============ Image sending ============

/**
 * Upload and send an image message to any C2C/Group target.
 */
export async function sendImage(
  target: DeliveryTarget,
  imageUrl: string,
  creds: AccountCreds,
  opts?: { msgId?: string; content?: string; localPath?: string },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`Image sending not supported for target type: ${target.type}`);
  }

  const ctx = resolveAccount(creds.appId);
  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const isBase64 = imageUrl.startsWith("data:");
  let uploadOpts: { url?: string; fileData?: string };
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    uploadOpts = { fileData: matches[2] };
  } else {
    uploadOpts = { url: imageUrl };
  }

  const uploadResult = await ctx.mediaApi.uploadMedia(
    scope,
    target.id,
    MediaFileType.IMAGE,
    c,
    uploadOpts,
  );

  const meta: OutboundMeta = {
    text: opts?.content,
    mediaType: "image",
    ...(!isBase64 ? { mediaUrl: imageUrl } : {}),
    ...(opts?.localPath ? { mediaLocalPath: opts.localPath } : {}),
  };

  const result = await ctx.mediaApi.sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts?.msgId,
    content: opts?.content,
  });

  notifyMediaHook(creds.appId, result, meta);

  return result;
}

// ============ Voice sending ============

/**
 * Upload and send a voice message.
 */
export async function sendVoiceMessage(
  target: DeliveryTarget,
  creds: AccountCreds,
  opts: {
    voiceBase64?: string;
    voiceUrl?: string;
    msgId?: string;
    ttsText?: string;
    filePath?: string;
  },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`Voice sending not supported for target type: ${target.type}`);
  }

  const ctx = resolveAccount(creds.appId);
  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const uploadResult = await ctx.mediaApi.uploadMedia(scope, target.id, MediaFileType.VOICE, c, {
    url: opts.voiceUrl,
    fileData: opts.voiceBase64,
  });

  const result = await ctx.mediaApi.sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts.msgId,
  });

  notifyMediaHook(creds.appId, result, {
    mediaType: "voice",
    ...(opts.ttsText ? { ttsText: opts.ttsText } : {}),
    ...(opts.filePath ? { mediaLocalPath: opts.filePath } : {}),
  });

  return result;
}

// ============ Video sending ============

/**
 * Upload and send a video message.
 */
export async function sendVideoMessage(
  target: DeliveryTarget,
  creds: AccountCreds,
  opts: {
    videoUrl?: string;
    videoBase64?: string;
    msgId?: string;
    content?: string;
    localPath?: string;
  },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`Video sending not supported for target type: ${target.type}`);
  }

  const ctx = resolveAccount(creds.appId);
  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const uploadResult = await ctx.mediaApi.uploadMedia(scope, target.id, MediaFileType.VIDEO, c, {
    url: opts.videoUrl,
    fileData: opts.videoBase64,
  });

  const result = await ctx.mediaApi.sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts.msgId,
    content: opts.content,
  });

  notifyMediaHook(creds.appId, result, {
    text: opts.content,
    mediaType: "video",
    ...(opts.videoUrl ? { mediaUrl: opts.videoUrl } : {}),
    ...(opts.localPath ? { mediaLocalPath: opts.localPath } : {}),
  });

  return result;
}

// ============ File sending ============

/**
 * Upload and send a file message.
 */
export async function sendFileMessage(
  target: DeliveryTarget,
  creds: AccountCreds,
  opts: {
    fileBase64?: string;
    fileUrl?: string;
    msgId?: string;
    fileName?: string;
    localFilePath?: string;
  },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`File sending not supported for target type: ${target.type}`);
  }

  const ctx = resolveAccount(creds.appId);
  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const uploadResult = await ctx.mediaApi.uploadMedia(scope, target.id, MediaFileType.FILE, c, {
    url: opts.fileUrl,
    fileData: opts.fileBase64,
    fileName: opts.fileName,
  });

  const result = await ctx.mediaApi.sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts.msgId,
  });

  notifyMediaHook(creds.appId, result, {
    mediaType: "file",
    mediaUrl: opts.fileUrl,
    mediaLocalPath: opts.localFilePath ?? opts.fileName,
  });

  return result;
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
