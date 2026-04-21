import { createRequire } from "node:module";
import os from "node:os";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import {
  fetchWithSsrFGuard,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { debugLog, debugError } from "./utils/debug-log.js";
import { sanitizeFileName } from "./utils/platform.js";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "./utils/upload-cache.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// Plugin User-Agent format: QQBotPlugin/{version} (Node/{nodeVersion}; {os})
const _require = createRequire(import.meta.url);
const _pluginVersion = readPluginPackageVersion({ require: _require });
export const PLUGIN_USER_AGENT = `QQBotPlugin/${_pluginVersion} (Node/${process.versions.node}; ${os.platform()})`;

// =========================================================================
// Per-appId runtime config (avoids multi-account global state conflicts)
// =========================================================================
const markdownSupportMap = new Map<string, boolean>();

/** Structured metadata recorded for outbound messages. */
export interface OutboundMeta {
  text?: string;
  mediaType?: "image" | "voice" | "video" | "file";
  mediaUrl?: string;
  mediaLocalPath?: string;
  ttsText?: string;
}

type OnMessageSentCallback = (refIdx: string, meta: OutboundMeta) => void;
const onMessageSentHookMap = new Map<string, OnMessageSentCallback>();

/** Register an outbound-message hook scoped to one appId. */
export function onMessageSent(appId: string, callback: OnMessageSentCallback): void {
  onMessageSentHookMap.set(normalizeOptionalString(appId) ?? "", callback);
}

/** Initialize per-app API behavior such as markdown support. */
export function initApiConfig(appId: string, options: { markdownSupport?: boolean }): void {
  markdownSupportMap.set(normalizeOptionalString(appId) ?? "", options.markdownSupport === true);
}

/** Return whether markdown is enabled for the given appId. */
export function isMarkdownSupport(appId: string): boolean {
  return markdownSupportMap.get(normalizeOptionalString(appId) ?? "") ?? false;
}

// Keep token state per appId to avoid multi-account cross-talk.
const tokenCacheMap = new Map<string, { token: string; expiresAt: number; appId: string }>();
const tokenFetchPromises = new Map<string, Promise<string>>();

/**
 * Resolve an access token with caching and singleflight semantics.
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const normalizedAppId = normalizeOptionalString(appId) ?? "";
  const cachedToken = tokenCacheMap.get(normalizedAppId);

  // Refresh slightly ahead of expiry without making short-lived tokens unusable.
  const REFRESH_AHEAD_MS = cachedToken
    ? Math.min(5 * 60 * 1000, (cachedToken.expiresAt - Date.now()) / 3)
    : 0;
  if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_AHEAD_MS) {
    return cachedToken.token;
  }

  let fetchPromise = tokenFetchPromises.get(normalizedAppId);
  if (fetchPromise) {
    debugLog(
      `[qqbot-api:${normalizedAppId}] Token fetch in progress, waiting for existing request...`,
    );
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      return await doFetchToken(normalizedAppId, clientSecret);
    } finally {
      tokenFetchPromises.delete(normalizedAppId);
    }
  })();

  tokenFetchPromises.set(normalizedAppId, fetchPromise);
  return fetchPromise;
}

/** Perform the token fetch request. */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret };
  const requestHeaders = { "Content-Type": "application/json", "User-Agent": PLUGIN_USER_AGENT };

  debugLog(`[qqbot-api:${appId}] >>> POST ${TOKEN_URL}`);

  let response: Response;
  let release = async () => {};
  try {
    const guarded = await fetchWithSsrFGuard({
      url: TOKEN_URL,
      init: {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      },
      auditContext: "qqbot.token",
    });
    response = guarded.response;
    release = guarded.release;
  } catch (err) {
    debugError(`[qqbot-api:${appId}] <<< Network error:`, err);
    throw new Error(`Network error getting access_token: ${formatErrorMessage(err)}`, {
      cause: err,
    });
  }

  try {
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const tokenTraceId = response.headers.get("x-tps-trace-id") ?? "";
    debugLog(
      `[qqbot-api:${appId}] <<< Status: ${response.status} ${response.statusText}${tokenTraceId ? ` | TraceId: ${tokenTraceId}` : ""}`,
    );

    let data: { access_token?: string; expires_in?: number };
    let rawBody: string;
    try {
      rawBody = await response.text();
      // Redact the token before logging the raw response body.
      const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
      debugLog(`[qqbot-api:${appId}] <<< Body:`, logBody);
      data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number };
    } catch (err) {
      debugError(`[qqbot-api:${appId}] <<< Parse error:`, err);
      throw new Error(`Failed to parse access_token response: ${formatErrorMessage(err)}`, {
        cause: err,
      });
    }

    if (!data.access_token) {
      throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
    }

    const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;

    tokenCacheMap.set(appId, {
      token: data.access_token,
      expiresAt,
      appId,
    });

    debugLog(`[qqbot-api:${appId}] Token cached, expires at: ${new Date(expiresAt).toISOString()}`);
    return data.access_token;
  } finally {
    await release();
  }
}

/** Clear one token cache or all token caches. */
export function clearTokenCache(appId?: string): void {
  if (appId) {
    const normalizedAppId = normalizeOptionalString(appId) ?? "";
    tokenCacheMap.delete(normalizedAppId);
    debugLog(`[qqbot-api:${normalizedAppId}] Token cache cleared manually.`);
  } else {
    tokenCacheMap.clear();
    debugLog(`[qqbot-api] All token caches cleared.`);
  }
}

/** Return token-cache status for diagnostics. */
export function getTokenStatus(appId: string): {
  status: "valid" | "expired" | "refreshing" | "none";
  expiresAt: number | null;
} {
  if (tokenFetchPromises.has(appId)) {
    return { status: "refreshing", expiresAt: tokenCacheMap.get(appId)?.expiresAt ?? null };
  }
  const cached = tokenCacheMap.get(appId);
  if (!cached) {
    return { status: "none", expiresAt: null };
  }
  const remaining = cached.expiresAt - Date.now();
  const isValid = remaining > Math.min(5 * 60 * 1000, remaining / 3);
  return { status: isValid ? "valid" : "expired", expiresAt: cached.expiresAt };
}

/** Generate a message sequence in the 0..65535 range. */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000;
  const random = Math.floor(Math.random() * 65536);
  return (timePart ^ random) % 65536;
}

const DEFAULT_API_TIMEOUT = 30000;
const FILE_UPLOAD_TIMEOUT = 120000;

/** Shared API request wrapper. */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": PLUGIN_USER_AGENT,
  };

  const isFileUpload = path.includes("/files");
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  debugLog(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`);
  if (body) {
    const logBody = { ...body } as Record<string, unknown>;
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${logBody.file_data.length} chars>`;
    }
    debugLog(`[qqbot-api] >>> Body:`, JSON.stringify(logBody));
  }

  let res: Response;
  let release = async () => {};
  try {
    const guarded = await fetchWithSsrFGuard({
      url,
      init: options,
      auditContext: `qqbot.api${path}`,
    });
    res = guarded.response;
    release = guarded.release;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      debugError(`[qqbot-api] <<< Request timeout after ${timeout}ms`);
      throw new Error(`Request timeout[${path}]: exceeded ${timeout}ms`, { cause: err });
    }
    debugError(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error [${path}]: ${formatErrorMessage(err)}`, { cause: err });
  } finally {
    clearTimeout(timeoutId);
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const traceId = res.headers.get("x-tps-trace-id") ?? "";
  debugLog(
    `[qqbot-api] <<< Status: ${res.status} ${res.statusText}${traceId ? ` | TraceId: ${traceId}` : ""}`,
  );

  try {
    let data: T;
    const rawBody = await res.text();
    debugLog(`[qqbot-api] <<< Body:`, rawBody);
    data = JSON.parse(rawBody) as T;

    if (!res.ok) {
      const error = data as { message?: string; code?: number };
      throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`);
    }

    return data;
  } catch (err) {
    throw new Error(`Failed to parse response[${path}]: ${formatErrorMessage(err)}`, {
      cause: err,
    });
  } finally {
    await release();
  }
}

// Upload retry with exponential backoff.

const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1000;

async function apiRequestWithRetry<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  maxRetries = UPLOAD_MAX_RETRIES,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiRequest<T>(accessToken, method, path, body);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const errMsg = lastError.message;
      if (
        errMsg.includes("400") ||
        errMsg.includes("401") ||
        errMsg.includes("Invalid") ||
        errMsg.includes("upload timeout") ||
        errMsg.includes("timeout") ||
        errMsg.includes("Timeout")
      ) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
        debugLog(
          `[qqbot-api] Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${errMsg.slice(0, 100)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway");
  return data.url;
}

// Message sending.

export interface MessageResponse {
  id: string;
  timestamp: number | string;
  ext_info?: {
    ref_idx?: string;
  };
}

/**
 * Send a message and invoke the refIdx hook when QQ returns one.
 */
async function sendAndNotify(
  appId: string,
  accessToken: string,
  method: string,
  path: string,
  body: unknown,
  meta: OutboundMeta,
): Promise<MessageResponse> {
  const result = await apiRequest<MessageResponse>(accessToken, method, path, body);
  const hook = onMessageSentHookMap.get(normalizeOptionalString(appId) ?? "");
  if (result.ext_info?.ref_idx && hook) {
    try {
      hook(result.ext_info.ref_idx, meta);
    } catch (err) {
      debugError(`[qqbot-api:${appId}] onMessageSent hook error: ${String(err)}`);
    }
  }
  return result;
}

function buildMessageBody(
  appId: string,
  content: string,
  msgId: string | undefined,
  msgSeq: number,
  messageReference?: string,
): Record<string, unknown> {
  const md = isMarkdownSupport(appId);
  const body: Record<string, unknown> = md
    ? {
        markdown: { content },
        msg_type: 2,
        msg_seq: msgSeq,
      }
    : {
        content,
        msg_type: 0,
        msg_seq: msgSeq,
      };

  if (msgId) {
    body.msg_id = msgId;
  }
  if (messageReference && !md) {
    body.message_reference = { message_id: messageReference };
  }
  return body;
}

export async function sendC2CMessage(
  appId: string,
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  messageReference?: string,
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(appId, content, msgId, msgSeq, messageReference);
  return sendAndNotify(appId, accessToken, "POST", `/v2/users/${openid}/messages`, body, {
    text: content,
  });
}

export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
): Promise<{ refIdx?: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  };
  const response = await apiRequest<{ ext_info?: { ref_idx?: string } }>(
    accessToken,
    "POST",
    `/v2/users/${openid}/messages`,
    body,
  );
  return { refIdx: response.ext_info?.ref_idx };
}

export async function sendChannelMessage(
  accessToken: string,
  channelId: string,
  content: string,
  msgId?: string,
): Promise<MessageResponse> {
  return apiRequest(accessToken, "POST", `/channels/${channelId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/** Send a direct-message payload inside a guild DM session. */
export async function sendDmMessage(
  accessToken: string,
  guildId: string,
  content: string,
  msgId?: string,
): Promise<{ id: string; timestamp: string }> {
  return apiRequest(accessToken, "POST", `/dms/${guildId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendGroupMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(appId, content, msgId, msgSeq);
  return sendAndNotify(appId, accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, {
    text: content,
  });
}

function buildProactiveMessageBody(appId: string, content: string): Record<string, unknown> {
  if (!content || content.trim().length === 0) {
    throw new Error("Proactive message content must not be empty (markdown.content is empty)");
  }
  if (isMarkdownSupport(appId)) {
    return { markdown: { content }, msg_type: 2 };
  } else {
    return { content, msg_type: 0 };
  }
}

export async function sendProactiveC2CMessage(
  appId: string,
  accessToken: string,
  openid: string,
  content: string,
): Promise<MessageResponse> {
  const body = buildProactiveMessageBody(appId, content);
  return sendAndNotify(appId, accessToken, "POST", `/v2/users/${openid}/messages`, body, {
    text: content,
  });
}

export async function sendProactiveGroupMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  content: string,
): Promise<MessageResponse> {
  const body = buildProactiveMessageBody(appId, content);
  return sendAndNotify(appId, accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, {
    text: content,
  });
}

// Rich media message support.

export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string;
}

async function assertDirectUploadUrlAllowed(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Invalid media URL: ${formatErrorMessage(err)}`, { cause: err });
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Direct-upload media URL must use HTTPS");
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname);
  return parsed.toString();
}

export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadC2CMedia: url or fileData is required");
  }

  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "c2c", openid, fileType);
    if (cachedInfo) {
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) {
    body.url = await assertDirectUploadUrlAllowed(url);
  } else if (fileData) {
    body.file_data = fileData;
  }
  if (fileType === MediaFileType.FILE && fileName) {
    body.file_name = sanitizeFileName(fileName);
  }

  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken,
    "POST",
    `/v2/users/${openid}/files`,
    body,
  );

  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(
      contentHash,
      "c2c",
      openid,
      fileType,
      result.file_info,
      result.file_uuid,
      result.ttl,
    );
  }
  return result;
}

export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadGroupMedia: url or fileData is required");
  }

  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "group", groupOpenid, fileType);
    if (cachedInfo) {
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) {
    body.url = await assertDirectUploadUrlAllowed(url);
  } else if (fileData) {
    body.file_data = fileData;
  }
  if (fileType === MediaFileType.FILE && fileName) {
    body.file_name = sanitizeFileName(fileName);
  }

  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken,
    "POST",
    `/v2/groups/${groupOpenid}/files`,
    body,
  );

  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(
      contentHash,
      "group",
      groupOpenid,
      fileType,
      result.file_info,
      result.file_uuid,
      result.ttl,
    );
  }
  return result;
}

export async function sendC2CMediaMessage(
  appId: string,
  accessToken: string,
  openid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
  meta?: OutboundMeta,
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return sendAndNotify(
    appId,
    accessToken,
    "POST",
    `/v2/users/${openid}/messages`,
    {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: msgSeq,
      ...(content ? { content } : {}),
      ...(msgId ? { msg_id: msgId } : {}),
    },
    meta ?? { text: content },
  );
}

export async function sendGroupMediaMessage(
  accessToken: string,
  groupOpenid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendC2CImageMessage(
  appId: string,
  accessToken: string,
  openid: string,
  imageUrl: string,
  msgId?: string,
  content?: string,
  localPath?: string,
): Promise<MessageResponse> {
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith("data:");
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    uploadResult = await uploadC2CMedia(
      accessToken,
      openid,
      MediaFileType.IMAGE,
      undefined,
      matches[2],
      false,
    );
  } else {
    uploadResult = await uploadC2CMedia(
      accessToken,
      openid,
      MediaFileType.IMAGE,
      imageUrl,
      undefined,
      false,
    );
  }
  const meta: OutboundMeta = {
    text: content,
    mediaType: "image",
    ...(!isBase64 ? { mediaUrl: imageUrl } : {}),
    ...(localPath ? { mediaLocalPath: localPath } : {}),
  };
  return sendC2CMediaMessage(
    appId,
    accessToken,
    openid,
    uploadResult.file_info,
    msgId,
    content,
    meta,
  );
}

export async function sendGroupImageMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  imageUrl: string,
  msgId?: string,
  content?: string,
): Promise<{ id: string; timestamp: string }> {
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith("data:");
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    uploadResult = await uploadGroupMedia(
      accessToken,
      groupOpenid,
      MediaFileType.IMAGE,
      undefined,
      matches[2],
      false,
    );
  } else {
    uploadResult = await uploadGroupMedia(
      accessToken,
      groupOpenid,
      MediaFileType.IMAGE,
      imageUrl,
      undefined,
      false,
    );
  }
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

export async function sendC2CVoiceMessage(
  appId: string,
  accessToken: string,
  openid: string,
  voiceBase64?: string,
  voiceUrl?: string,
  msgId?: string,
  ttsText?: string,
  filePath?: string,
): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    MediaFileType.VOICE,
    voiceUrl,
    voiceBase64,
    false,
  );
  return sendC2CMediaMessage(appId, accessToken, openid, uploadResult.file_info, msgId, undefined, {
    mediaType: "voice",
    ...(ttsText ? { ttsText } : {}),
    ...(filePath ? { mediaLocalPath: filePath } : {}),
  });
}

export async function sendGroupVoiceMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  voiceBase64?: string,
  voiceUrl?: string,
  msgId?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(
    accessToken,
    groupOpenid,
    MediaFileType.VOICE,
    voiceUrl,
    voiceBase64,
    false,
  );
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CFileMessage(
  appId: string,
  accessToken: string,
  openid: string,
  fileBase64?: string,
  fileUrl?: string,
  msgId?: string,
  fileName?: string,
  localFilePath?: string,
): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    MediaFileType.FILE,
    fileUrl,
    fileBase64,
    false,
    fileName,
  );
  return sendC2CMediaMessage(appId, accessToken, openid, uploadResult.file_info, msgId, undefined, {
    mediaType: "file",
    mediaUrl: fileUrl,
    mediaLocalPath: localFilePath ?? fileName,
  });
}

export async function sendGroupFileMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  fileBase64?: string,
  fileUrl?: string,
  msgId?: string,
  fileName?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(
    accessToken,
    groupOpenid,
    MediaFileType.FILE,
    fileUrl,
    fileBase64,
    false,
    fileName,
  );
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CVideoMessage(
  appId: string,
  accessToken: string,
  openid: string,
  videoUrl?: string,
  videoBase64?: string,
  msgId?: string,
  content?: string,
  localPath?: string,
): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    MediaFileType.VIDEO,
    videoUrl,
    videoBase64,
    false,
  );
  return sendC2CMediaMessage(appId, accessToken, openid, uploadResult.file_info, msgId, content, {
    text: content,
    mediaType: "video",
    ...(videoUrl ? { mediaUrl: videoUrl } : {}),
    ...(localPath ? { mediaLocalPath: localPath } : {}),
  });
}

export async function sendGroupVideoMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  videoUrl?: string,
  videoBase64?: string,
  msgId?: string,
  content?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(
    accessToken,
    groupOpenid,
    MediaFileType.VIDEO,
    videoUrl,
    videoBase64,
    false,
  );
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

// Background token refresh, isolated per appId.

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number;
  randomOffsetMs?: number;
  minRefreshIntervalMs?: number;
  retryDelayMs?: number;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

const backgroundRefreshControllers = new Map<string, AbortController>();

export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions,
): void {
  if (backgroundRefreshControllers.has(appId)) {
    debugLog(`[qqbot-api:${appId}] Background token refresh already running`);
    return;
  }

  const {
    refreshAheadMs = 5 * 60 * 1000,
    randomOffsetMs = 30 * 1000,
    minRefreshIntervalMs = 60 * 1000,
    retryDelayMs = 5 * 1000,
    log,
  } = options ?? {};

  const controller = new AbortController();
  backgroundRefreshControllers.set(appId, controller);
  const signal = controller.signal;

  const refreshLoop = async () => {
    log?.info?.(`[qqbot-api:${appId}] Background token refresh started`);

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret);
        const cached = tokenCacheMap.get(appId);

        if (cached) {
          const expiresIn = cached.expiresAt - Date.now();
          const randomOffset = Math.random() * randomOffsetMs;
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs,
          );

          log?.debug?.(
            `[qqbot-api:${appId}] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`,
          );
          await sleep(refreshIn, signal);
        } else {
          log?.debug?.(`[qqbot-api:${appId}] No cached token, retrying soon`);
          await sleep(minRefreshIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) {
          break;
        }
        log?.error?.(`[qqbot-api:${appId}] Background token refresh failed: ${String(err)}`);
        await sleep(retryDelayMs, signal);
      }
    }

    backgroundRefreshControllers.delete(appId);
    log?.info?.(`[qqbot-api:${appId}] Background token refresh stopped`);
  };

  refreshLoop().catch((err) => {
    backgroundRefreshControllers.delete(appId);
    log?.error?.(`[qqbot-api:${appId}] Background token refresh crashed: ${err}`);
  });
}

/**
 * Stop background token refresh.
 * @param appId Optional appId to stop a single account instead of all refresh loops.
 */
export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId) {
    const controller = backgroundRefreshControllers.get(appId);
    if (controller) {
      controller.abort();
      backgroundRefreshControllers.delete(appId);
    }
  } else {
    for (const controller of backgroundRefreshControllers.values()) {
      controller.abort();
    }
    backgroundRefreshControllers.clear();
  }
}

export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  if (appId) {
    return backgroundRefreshControllers.has(appId);
  }
  return backgroundRefreshControllers.size > 0;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
