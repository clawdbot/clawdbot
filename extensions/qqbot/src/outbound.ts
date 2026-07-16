import * as fs from "node:fs";
import * as path from "path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  getAccessToken,
  sendC2CFileMessage,
  sendC2CImageMessage,
  sendC2CMessage,
  sendC2CVideoMessage,
  sendC2CVoiceMessage,
  sendChannelMessage,
  sendDmMessage,
  sendGroupFileMessage,
  sendGroupImageMessage,
  sendGroupMessage,
  sendGroupVideoMessage,
  sendGroupVoiceMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
} from "./api.js";
import type { ResolvedQQBotAccount } from "./types.js";
import {
  audioFileToSilkBase64,
  isAudioFile,
  shouldTranscodeVoice,
  waitForFile,
} from "./utils/audio-convert.js";
import { debugError, debugLog, debugWarn } from "./utils/debug-log.js";
import {
  checkFileSize,
  downloadFile,
  fileExistsAsync,
  formatFileSize,
  readFileAsync,
} from "./utils/file-utils.js";
import { normalizeMediaTags } from "./utils/media-tags.js";
import { decodeCronPayload } from "./utils/payload.js";
import {
  getQQBotDataDir,
  getQQBotMediaDir,
  isLocalPath as isLocalFilePath,
  normalizePath,
  resolveQQBotPayloadLocalFilePath,
  sanitizeFileName,
} from "./utils/platform.js";

// Limit passive replies per message_id within the QQ Bot reply window.
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000;

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

type QQMessageResult = {
  ext_info?: {
    ref_idx?: string;
  };
};

const messageReplyTracker = new Map<string, MessageReplyRecord>();

function getRefIdx(result: QQMessageResult): string | undefined {
  return result.ext_info?.ref_idx;
}

/** Result of the passive-reply limit check. */
export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  shouldFallbackToProactive: boolean;
  fallbackReason?: "expired" | "limit_exceeded";
  message?: string;
}

/** Check whether a message can still receive a passive reply. */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  // Opportunistically evict expired records to keep the tracker bounded.
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }

  if (!record) {
    return {
      allowed: true,
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }

  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: "Message is older than 1 hour; sending as a proactive message instead",
    };
  }

  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "limit_exceeded",
      message: `Passive reply limit reached (${MESSAGE_REPLY_LIMIT} per hour); sending proactively instead`,
    };
  }

  return {
    allowed: true,
    remaining,
    shouldFallbackToProactive: false,
  };
}

/** Record one passive reply against a message. */
export function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
  debugLog(
    `[qqbot] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`,
  );
}

/** Return reply-tracker stats for diagnostics. */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of messageReplyTracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: messageReplyTracker.size, totalReplies };
}

/** Return the passive-reply configuration. */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
  mimeType?: string;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
  refIdx?: string;
}

/** Parse a qqbot target into a structured delivery target. */
function parseTarget(to: string): { type: "c2c" | "group" | "channel"; id: string } {
  const timestamp = new Date().toISOString();
  debugLog(`[${timestamp}] [qqbot] parseTarget: input=${to}`);

  let id = to.replace(/^qqbot:/i, "");

  if (id.startsWith("c2c:")) {
    const userId = id.slice(4);
    if (!userId || userId.length === 0) {
      const error = `Invalid c2c target format: ${to} - missing user ID`;
      debugError(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    debugLog(`[${timestamp}] [qqbot] parseTarget: c2c target, user ID=${userId}`);
    return { type: "c2c", id: userId };
  }

  if (id.startsWith("group:")) {
    const groupId = id.slice(6);
    if (!groupId || groupId.length === 0) {
      const error = `Invalid group target format: ${to} - missing group ID`;
      debugError(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    debugLog(`[${timestamp}] [qqbot] parseTarget: group target, group ID=${groupId}`);
    return { type: "group", id: groupId };
  }

  if (id.startsWith("channel:")) {
    const channelId = id.slice(8);
    if (!channelId || channelId.length === 0) {
      const error = `Invalid channel target format: ${to} - missing channel ID`;
      debugError(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    debugLog(`[${timestamp}] [qqbot] parseTarget: channel target, channel ID=${channelId}`);
    return { type: "channel", id: channelId };
  }

  if (!id || id.length === 0) {
    const error = `Invalid target format: ${to} - empty ID after removing qqbot: prefix`;
    debugError(`[${timestamp}] [qqbot] parseTarget: ${error}`);
    throw new Error(error);
  }

  debugLog(`[${timestamp}] [qqbot] parseTarget: default c2c target, ID=${id}`);
  return { type: "c2c", id };
}

// Structured media send helpers shared by gateway delivery and sendText.

/** Normalized target information for media sends. */
export interface MediaTargetContext {
  targetType: "c2c" | "group" | "channel" | "dm";
  targetId: string;
  account: ResolvedQQBotAccount;
  replyToId?: string;
  logPrefix?: string;
}

/** Build a media target from a normal outbound context. */
function buildMediaTarget(
  ctx: { to: string; account: ResolvedQQBotAccount; replyToId?: string | null },
  logPrefix?: string,
): MediaTargetContext {
  const target = parseTarget(ctx.to);
  return {
    targetType: target.type,
    targetId: target.id,
    account: ctx.account,
    replyToId: ctx.replyToId ?? undefined,
    logPrefix,
  };
}

/** Resolve an authenticated access token for the account. */
async function getToken(account: ResolvedQQBotAccount): Promise<string> {
  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }
  return getAccessToken(account.appId, account.clientSecret);
}

/** Return true when public URLs should be passed through directly. */
function shouldDirectUploadUrl(account: ResolvedQQBotAccount): boolean {
  return account.config?.urlDirectUpload !== false;
}

type QQBotMediaKind = "image" | "voice" | "video" | "file" | "media";

const qqBotMediaKindLabel: Record<QQBotMediaKind, string> = {
  image: "Image",
  voice: "Voice",
  video: "Video",
  file: "File",
  media: "Media",
};

type ResolvedOutboundMediaPath = { ok: true; mediaPath: string } | { ok: false; error: string };
type ResolveOutboundMediaPathOptions = {
  allowMissingLocalPath?: boolean;
  extraLocalRoots?: string[];
};
type SendDocumentOptions = {
  allowQQBotDataDownloads?: boolean;
};

function isHttpOrDataSource(pathValue: string): boolean {
  return (
    pathValue.startsWith("http://") ||
    pathValue.startsWith("https://") ||
    pathValue.startsWith("data:")
  );
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveMissingPathWithinMediaRoot(normalizedPath: string): string | null {
  const resolvedCandidate = path.resolve(normalizedPath);
  if (fs.existsSync(resolvedCandidate)) {
    return null;
  }

  const allowedRoot = path.resolve(getQQBotMediaDir());
  let canonicalAllowedRoot: string;
  try {
    canonicalAllowedRoot = fs.realpathSync(allowedRoot);
  } catch {
    return null;
  }

  const missingSegments: string[] = [];
  let cursor = resolvedCandidate;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }

  if (!fs.existsSync(cursor)) {
    return null;
  }

  let canonicalCursor: string;
  try {
    canonicalCursor = fs.realpathSync(cursor);
  } catch {
    return null;
  }
  const canonicalCandidate =
    missingSegments.length > 0 ? path.join(canonicalCursor, ...missingSegments) : canonicalCursor;

  return isPathWithinRoot(canonicalCandidate, canonicalAllowedRoot) ? canonicalCandidate : null;
}

function resolveExistingPathWithinRoots(
  normalizedPath: string,
  allowedRoots: readonly string[],
): string | null {
  const resolvedCandidate = path.resolve(normalizedPath);
  if (!fs.existsSync(resolvedCandidate)) {
    return null;
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = fs.realpathSync(resolvedCandidate);
  } catch {
    return null;
  }

  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    const canonicalRoot = fs.existsSync(resolvedRoot)
      ? fs.realpathSync(resolvedRoot)
      : resolvedRoot;
    if (isPathWithinRoot(canonicalCandidate, canonicalRoot)) {
      return canonicalCandidate;
    }
  }

  return null;
}

function resolveOutboundMediaPath(
  rawPath: string,
  prefix: string,
  mediaKind: QQBotMediaKind,
  options: ResolveOutboundMediaPathOptions = {},
): ResolvedOutboundMediaPath {
  const normalizedPath = normalizePath(rawPath);
  if (isHttpOrDataSource(normalizedPath)) {
    return { ok: true, mediaPath: normalizedPath };
  }

  const allowedPath = resolveQQBotPayloadLocalFilePath(normalizedPath);
  if (allowedPath) {
    return { ok: true, mediaPath: allowedPath };
  }

  if (options.extraLocalRoots && options.extraLocalRoots.length > 0) {
    const extraAllowedPath = resolveExistingPathWithinRoots(
      normalizedPath,
      options.extraLocalRoots,
    );
    if (extraAllowedPath) {
      return { ok: true, mediaPath: extraAllowedPath };
    }
  }

  if (options.allowMissingLocalPath) {
    const allowedMissingPath = resolveMissingPathWithinMediaRoot(normalizedPath);
    if (allowedMissingPath) {
      return { ok: true, mediaPath: allowedMissingPath };
    }
  }

  debugWarn(`${prefix} blocked local ${mediaKind} path outside QQ Bot media storage`);
  return {
    ok: false,
    error: `${qqBotMediaKindLabel[mediaKind]} path must be inside QQ Bot media storage`,
  };
}

/**
 * Send a photo from a local file, public URL, or Base64 data URL.
 */
export async function sendPhoto(
  ctx: MediaTargetContext,
  imagePath: string,
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const resolvedMediaPath = resolveOutboundMediaPath(imagePath, prefix, "image");
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaPath = resolvedMediaPath.mediaPath;
  const isLocal = isLocalFilePath(mediaPath);
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
  const isData = mediaPath.startsWith("data:");

  // Force a local download before upload when direct URL upload is disabled.
  if (isHttp && !shouldDirectUploadUrl(ctx.account)) {
    debugLog(`${prefix} sendPhoto: urlDirectUpload=false, downloading URL first...`);
    const localFile = await downloadToFallbackDir(mediaPath, prefix, "sendPhoto");
    if (localFile) {
      return await sendPhoto(ctx, localFile);
    }
    return { channel: "qqbot", error: `Failed to download image: ${mediaPath.slice(0, 80)}` };
  }

  let imageUrl = mediaPath;

  if (isLocal) {
    if (!(await fileExistsAsync(mediaPath))) {
      return { channel: "qqbot", error: "Image not found" };
    }
    const sizeCheck = checkFileSize(mediaPath);
    if (!sizeCheck.ok) {
      return { channel: "qqbot", error: sizeCheck.error! };
    }
    const fileBuffer = await readFileAsync(mediaPath);
    const ext = normalizeLowercaseStringOrEmpty(path.extname(mediaPath));
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    };
    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      return { channel: "qqbot", error: `Unsupported image format: ${ext}` };
    }
    imageUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
    debugLog(`${prefix} sendPhoto: local → Base64 (${formatFileSize(fileBuffer.length)})`);
  } else if (!isHttp && !isData) {
    return { channel: "qqbot", error: `Unsupported image source: ${mediaPath.slice(0, 50)}` };
  }

  try {
    const token = await getToken(ctx.account);
    const localPath = isLocal ? mediaPath : undefined;

    if (ctx.targetType === "c2c") {
      const r = await sendC2CImageMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        imageUrl,
        ctx.replyToId,
        undefined,
        localPath,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupImageMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        imageUrl,
        ctx.replyToId,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      // Channel messages only support public URLs through markdown.
      if (isHttp) {
        const r = await sendChannelMessage(token, ctx.targetId, `![](${mediaPath})`, ctx.replyToId);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
      debugLog(`${prefix} sendPhoto: channel does not support local/Base64 images`);
      return { channel: "qqbot", error: "Channel does not support local/Base64 images" };
    }
  } catch (err) {
    const msg = formatErrorMessage(err);

    // Fall back to plugin-managed download + Base64 when QQ fails to fetch the URL directly.
    if (isHttp && !isData) {
      debugWarn(
        `${prefix} sendPhoto: URL direct upload failed (${msg}), downloading locally and retrying as Base64...`,
      );
      const retryResult = await downloadAndRetrySendPhoto(ctx, mediaPath, prefix);
      if (retryResult) {
        return retryResult;
      }
    }

    debugError(`${prefix} sendPhoto failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Download a remote image locally and retry `sendPhoto` through the local-file path. */
async function downloadAndRetrySendPhoto(
  ctx: MediaTargetContext,
  httpUrl: string,
  prefix: string,
): Promise<OutboundResult | null> {
  try {
    const downloadDir = getQQBotMediaDir("downloads", "url-fallback");
    const localFile = await downloadFile(httpUrl, downloadDir);
    if (!localFile) {
      debugError(`${prefix} sendPhoto fallback: download also failed for ${httpUrl.slice(0, 80)}`);
      return null;
    }

    debugLog(`${prefix} sendPhoto fallback: downloaded → ${localFile}, retrying as Base64`);
    return await sendPhoto(ctx, localFile);
  } catch (err) {
    debugError(`${prefix} sendPhoto fallback error:`, err);
    return null;
  }
}

/**
 * Send voice from either a local file or a public URL.
 *
 * URL handling respects `urlDirectUpload`, and local files are transcoded when needed.
 */
export async function sendVoice(
  ctx: MediaTargetContext,
  voicePath: string,
  directUploadFormats?: string[],
  transcodeEnabled: boolean = true,
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const resolvedMediaPath = resolveOutboundMediaPath(voicePath, prefix, "voice", {
    allowMissingLocalPath: true,
  });
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaPath = resolvedMediaPath.mediaPath;
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");

  if (isHttp) {
    if (shouldDirectUploadUrl(ctx.account)) {
      try {
        const token = await getToken(ctx.account);
        if (ctx.targetType === "c2c") {
          const r = await sendC2CVoiceMessage(
            ctx.account.appId,
            token,
            ctx.targetId,
            undefined,
            mediaPath,
            ctx.replyToId,
          );
          return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
        } else if (ctx.targetType === "group") {
          const r = await sendGroupVoiceMessage(
            ctx.account.appId,
            token,
            ctx.targetId,
            undefined,
            mediaPath,
            ctx.replyToId,
          );
          return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
        } else {
          debugLog(`${prefix} sendVoice: voice not supported in channel`);
          return { channel: "qqbot", error: "Voice not supported in channel" };
        }
      } catch (err) {
        const msg = formatErrorMessage(err);
        debugWarn(
          `${prefix} sendVoice: URL direct upload failed (${msg}), downloading locally and retrying...`,
        );
      }
    } else {
      debugLog(`${prefix} sendVoice: urlDirectUpload=false, downloading URL first...`);
    }

    const localFile = await downloadToFallbackDir(mediaPath, prefix, "sendVoice");
    if (localFile) {
      return await sendVoiceFromLocal(
        ctx,
        localFile,
        directUploadFormats,
        transcodeEnabled,
        prefix,
      );
    }
    return { channel: "qqbot", error: `Failed to download audio: ${mediaPath.slice(0, 80)}` };
  }

  return await sendVoiceFromLocal(ctx, mediaPath, directUploadFormats, transcodeEnabled, prefix);
}

/** Send voice from a local file. */
async function sendVoiceFromLocal(
  ctx: MediaTargetContext,
  mediaPath: string,
  directUploadFormats: string[] | undefined,
  transcodeEnabled: boolean,
  prefix: string,
): Promise<OutboundResult> {
  // TTS can still be flushing the file to disk, so wait for a stable file first.
  const fileSize = await waitForFile(mediaPath);
  if (fileSize === 0) {
    return { channel: "qqbot", error: "Voice generate failed" };
  }

  // Re-check containment after the file appears to prevent symlink-race escapes.
  const safeMediaPath = resolveQQBotPayloadLocalFilePath(mediaPath);
  if (!safeMediaPath) {
    debugWarn(`${prefix} sendVoice: blocked local voice path outside QQ Bot media storage`);
    return { channel: "qqbot", error: "Voice path must be inside QQ Bot media storage" };
  }

  const needsTranscode = shouldTranscodeVoice(safeMediaPath);

  if (needsTranscode && !transcodeEnabled) {
    const ext = normalizeLowercaseStringOrEmpty(path.extname(safeMediaPath));
    debugLog(
      `${prefix} sendVoice: transcode disabled, format ${ext} needs transcode, returning error for fallback`,
    );
    return {
      channel: "qqbot",
      error: `Voice transcoding is disabled and format ${ext} cannot be uploaded directly`,
    };
  }

  try {
    const silkBase64 = await audioFileToSilkBase64(safeMediaPath, directUploadFormats);
    let uploadBase64 = silkBase64;

    if (!uploadBase64) {
      const buf = await readFileAsync(safeMediaPath);
      uploadBase64 = buf.toString("base64");
      debugLog(
        `${prefix} sendVoice: SILK conversion failed, uploading raw (${formatFileSize(buf.length)})`,
      );
    } else {
      debugLog(`${prefix} sendVoice: SILK ready (${fileSize} bytes)`);
    }

    const token = await getToken(ctx.account);

    if (ctx.targetType === "c2c") {
      const r = await sendC2CVoiceMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        uploadBase64,
        undefined,
        ctx.replyToId,
        undefined,
        safeMediaPath,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupVoiceMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        uploadBase64,
        undefined,
        ctx.replyToId,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      debugLog(`${prefix} sendVoice: voice not supported in channel`);
      return { channel: "qqbot", error: "Voice not supported in channel" };
    }
  } catch (err) {
    const msg = formatErrorMessage(err);
    debugError(`${prefix} sendVoice (local) failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send video from either a public URL or a local file. */
export async function sendVideoMsg(
  ctx: MediaTargetContext,
  videoPath: string,
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const resolvedMediaPath = resolveOutboundMediaPath(videoPath, prefix, "video");
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaPath = resolvedMediaPath.mediaPath;
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");

  if (isHttp && !shouldDirectUploadUrl(ctx.account)) {
    debugLog(`${prefix} sendVideoMsg: urlDirectUpload=false, downloading URL first...`);
    const localFile = await downloadToFallbackDir(mediaPath, prefix, "sendVideoMsg");
    if (localFile) {
      return await sendVideoFromLocal(ctx, localFile, prefix);
    }
    return { channel: "qqbot", error: `Failed to download video: ${mediaPath.slice(0, 80)}` };
  }

  try {
    const token = await getToken(ctx.account);

    if (isHttp) {
      if (ctx.targetType === "c2c") {
        const r = await sendC2CVideoMessage(
          ctx.account.appId,
          token,
          ctx.targetId,
          mediaPath,
          undefined,
          ctx.replyToId,
        );
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else if (ctx.targetType === "group") {
        const r = await sendGroupVideoMessage(
          ctx.account.appId,
          token,
          ctx.targetId,
          mediaPath,
          undefined,
          ctx.replyToId,
        );
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else {
        debugLog(`${prefix} sendVideoMsg: video not supported in channel`);
        return { channel: "qqbot", error: "Video not supported in channel" };
      }
    }

    return await sendVideoFromLocal(ctx, mediaPath, prefix);
  } catch (err) {
    const msg = formatErrorMessage(err);

    // If direct URL upload fails, retry through a local download path.
    if (isHttp) {
      debugWarn(
        `${prefix} sendVideoMsg: URL direct upload failed (${msg}), downloading locally and retrying as Base64...`,
      );
      const localFile = await downloadToFallbackDir(mediaPath, prefix, "sendVideoMsg");
      if (localFile) {
        return await sendVideoFromLocal(ctx, localFile, prefix);
      }
    }

    debugError(`${prefix} sendVideoMsg failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send video from a local file. */
async function sendVideoFromLocal(
  ctx: MediaTargetContext,
  mediaPath: string,
  prefix: string,
): Promise<OutboundResult> {
  if (!(await fileExistsAsync(mediaPath))) {
    return { channel: "qqbot", error: "Video not found" };
  }
  const sizeCheck = checkFileSize(mediaPath);
  if (!sizeCheck.ok) {
    return { channel: "qqbot", error: sizeCheck.error! };
  }

  const fileBuffer = await readFileAsync(mediaPath);
  const videoBase64 = fileBuffer.toString("base64");
  debugLog(`${prefix} sendVideoMsg: local video (${formatFileSize(fileBuffer.length)})`);

  try {
    const token = await getToken(ctx.account);
    if (ctx.targetType === "c2c") {
      const r = await sendC2CVideoMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        undefined,
        videoBase64,
        ctx.replyToId,
        undefined,
        mediaPath,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupVideoMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        undefined,
        videoBase64,
        ctx.replyToId,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      debugLog(`${prefix} sendVideoMsg: video not supported in channel`);
      return { channel: "qqbot", error: "Video not supported in channel" };
    }
  } catch (err) {
    const msg = formatErrorMessage(err);
    debugError(`${prefix} sendVideoMsg (local) failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send a file from a local path or public URL. */
export async function sendDocument(
  ctx: MediaTargetContext,
  filePath: string,
  options: SendDocumentOptions = {},
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const extraLocalRoots = options.allowQQBotDataDownloads
    ? [getQQBotDataDir("downloads")]
    : undefined;
  const resolvedMediaPath = resolveOutboundMediaPath(filePath, prefix, "file", {
    extraLocalRoots,
  });
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaPath = resolvedMediaPath.mediaPath;
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
  const fileName = sanitizeFileName(path.basename(mediaPath));

  if (isHttp && !shouldDirectUploadUrl(ctx.account)) {
    debugLog(`${prefix} sendDocument: urlDirectUpload=false, downloading URL first...`);
    const localFile = await downloadToFallbackDir(mediaPath, prefix, "sendDocument");
    if (localFile) {
      return await sendDocumentFromLocal(ctx, localFile, prefix);
    }
    return { channel: "qqbot", error: `Failed to download file: ${mediaPath.slice(0, 80)}` };
  }

  try {
    const token = await getToken(ctx.account);

    if (isHttp) {
      if (ctx.targetType === "c2c") {
        const r = await sendC2CFileMessage(
          ctx.account.appId,
          token,
          ctx.targetId,
          undefined,
          mediaPath,
          ctx.replyToId,
          fileName,
        );
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else if (ctx.targetType === "group") {
        const r = await sendGroupFileMessage(
          ctx.account.appId,
          token,
          ctx.targetId,
          undefined,
          mediaPath,
          ctx.replyToId,
          fileName,
        );
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else {
        debugLog(`${prefix} sendDocument: file not supported in channel`);
        return { channel: "qqbot", error: "File not supported in channel" };
      }
    }

    return await sendDocumentFromLocal(ctx, mediaPath, prefix);
  } catch (err) {
    const msg = formatErrorMessage(err);

    // If direct URL upload fails, retry through a local download path.
    if (isHttp) {
      debugWarn(
        `${prefix} sendDocument: URL direct upload failed (${msg}), downloading locally and retrying as Base64...`,
      );
      const localFile = await downloadToFallbackDir(mediaPath, prefix, "sendDocument");
      if (localFile) {
        return await sendDocumentFromLocal(ctx, localFile, prefix);
      }
    }

    debugError(`${prefix} sendDocument failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send a file from local storage. */
async function sendDocumentFromLocal(
  ctx: MediaTargetContext,
  mediaPath: string,
  prefix: string,
): Promise<OutboundResult> {
  const fileName = sanitizeFileName(path.basename(mediaPath));

  if (!(await fileExistsAsync(mediaPath))) {
    return { channel: "qqbot", error: "File not found" };
  }
  const sizeCheck = checkFileSize(mediaPath);
  if (!sizeCheck.ok) {
    return { channel: "qqbot", error: sizeCheck.error! };
  }
  const fileBuffer = await readFileAsync(mediaPath);
  if (fileBuffer.length === 0) {
    return { channel: "qqbot", error: `File is empty: ${mediaPath}` };
  }
  const fileBase64 = fileBuffer.toString("base64");
  debugLog(`${prefix} sendDocument: local file (${formatFileSize(fileBuffer.length)})`);

  try {
    const token = await getToken(ctx.account);
    if (ctx.targetType === "c2c") {
      const r = await sendC2CFileMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        fileBase64,
        undefined,
        ctx.replyToId,
        fileName,
        mediaPath,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupFileMessage(
        ctx.account.appId,
        token,
        ctx.targetId,
        fileBase64,
        undefined,
        ctx.replyToId,
        fileName,
      );
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      debugLog(`${prefix} sendDocument: file not supported in channel`);
      return { channel: "qqbot", error: "File not supported in channel" };
    }
  } catch (err) {
    const msg = formatErrorMessage(err);
    debugError(`${prefix} sendDocument (local) failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Download a remote file into the fallback media directory. */
async function downloadToFallbackDir(
  httpUrl: string,
  prefix: string,
  caller: string,
): Promise<string | null> {
  try {
    const downloadDir = getQQBotMediaDir("downloads", "url-fallback");
    const localFile = await downloadFile(httpUrl, downloadDir);
    if (!localFile) {
      debugError(`${prefix} ${caller} fallback: download also failed for ${httpUrl.slice(0, 80)}`);
      return null;
    }
    debugLog(`${prefix} ${caller} fallback: downloaded → ${localFile}`);
    return localFile;
  } catch (err) {
    debugError(`${prefix} ${caller} fallback download error:`, err);
    return null;
  }
}

/**
 * Send text, optionally falling back from passive reply mode to proactive mode.
 *
 * Also supports inline media tags such as `<qqimg>...</qqimg>`.
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, account } = ctx;
  let { text, replyToId } = ctx;
  let fallbackToProactive = false;

  debugLog(
    "[qqbot] sendText ctx:",
    JSON.stringify(
      { to, text: text?.slice(0, 50), replyToId, accountId: account.accountId },
      null,
      2,
    ),
  );

  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);

    if (!limitCheck.allowed) {
      if (limitCheck.shouldFallbackToProactive) {
        debugWarn(
          `[qqbot] sendText: passive reply unavailable, falling back to proactive send - ${limitCheck.message}`,
        );
        fallbackToProactive = true;
        replyToId = null;
      } else {
        debugError(
          `[qqbot] sendText: passive reply was blocked without a fallback path - ${limitCheck.message}`,
        );
        return {
          channel: "qqbot",
          error: limitCheck.message,
        };
      }
    } else {
      debugLog(
        `[qqbot] sendText: remaining passive replies for ${replyToId}: ${limitCheck.remaining}/${MESSAGE_REPLY_LIMIT}`,
      );
    }
  }

  text = normalizeMediaTags(text);

  const mediaTagRegex =
    /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;
  const mediaTagMatches = text.match(mediaTagRegex);

  if (mediaTagMatches && mediaTagMatches.length > 0) {
    debugLog(`[qqbot] sendText: Detected ${mediaTagMatches.length} media tag(s), processing...`);

    // Preserve the original text/media ordering when sending mixed content.
    const sendQueue: Array<{
      type: "text" | "image" | "voice" | "video" | "file" | "media";
      content: string;
    }> = [];

    let lastIndex = 0;
    const mediaTagRegexWithIndex =
      /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;
    let match;

    while ((match = mediaTagRegexWithIndex.exec(text)) !== null) {
      const textBefore = text
        .slice(lastIndex, match.index)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (textBefore) {
        sendQueue.push({ type: "text", content: textBefore });
      }

      const tagName = normalizeLowercaseStringOrEmpty(match[1]);

      let mediaPath = normalizeOptionalString(match[2]) ?? "";
      if (mediaPath.startsWith("MEDIA:")) {
        mediaPath = mediaPath.slice("MEDIA:".length);
      }
      mediaPath = normalizePath(mediaPath);

      // Fix paths that the model emitted with markdown-style escaping.
      mediaPath = mediaPath.replace(/\\\\/g, "\\");

      // Skip octal escape decoding for Windows local paths (e.g. C:\Users\1\file.txt)
      // where backslash-digit sequences like \1, \2 ... \7 are directory separators,
      // not octal escape sequences.
      const isWinLocal = /^[a-zA-Z]:[\\/]/.test(mediaPath) || mediaPath.startsWith("\\\\");
      try {
        const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
        const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

        if (!isWinLocal && (hasOctal || hasNonASCII)) {
          debugLog(`[qqbot] sendText: Decoding path with mixed encoding: ${mediaPath}`);

          let decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
            return String.fromCharCode(parseInt(octal, 8));
          });

          const bytes: number[] = [];
          for (let i = 0; i < decoded.length; i++) {
            const code = decoded.charCodeAt(i);
            if (code <= 0xff) {
              bytes.push(code);
            } else {
              const charBytes = Buffer.from(decoded[i], "utf8");
              bytes.push(...charBytes);
            }
          }

          const buffer = Buffer.from(bytes);
          const utf8Decoded = buffer.toString("utf8");

          if (!utf8Decoded.includes("\uFFFD") || utf8Decoded.length < decoded.length) {
            mediaPath = utf8Decoded;
            debugLog(`[qqbot] sendText: Successfully decoded path: ${mediaPath}`);
          }
        }
      } catch (decodeErr) {
        debugError(
          `[qqbot] sendText: Path decode error: ${
            decodeErr instanceof Error ? decodeErr.message : JSON.stringify(decodeErr)
          }`,
        );
      }

      if (mediaPath) {
        if (tagName === "qqmedia") {
          sendQueue.push({ type: "media", content: mediaPath });
          debugLog(`[qqbot] sendText: Found auto-detect media in <qqmedia>: ${mediaPath}`);
        } else if (tagName === "qqvoice") {
          sendQueue.push({ type: "voice", content: mediaPath });
          debugLog(`[qqbot] sendText: Found voice path in <qqvoice>: ${mediaPath}`);
        } else if (tagName === "qqvideo") {
          sendQueue.push({ type: "video", content: mediaPath });
          debugLog(`[qqbot] sendText: Found video URL in <qqvideo>: ${mediaPath}`);
        } else if (tagName === "qqfile") {
          sendQueue.push({ type: "file", content: mediaPath });
          debugLog(`[qqbot] sendText: Found file path in <qqfile>: ${mediaPath}`);
        } else {
          sendQueue.push({ type: "image", content: mediaPath });
          debugLog(`[qqbot] sendText: Found image path in <qqimg>: ${mediaPath}`);
        }
      }

      lastIndex = match.index + match[0].length;
    }

    const textAfter = text
      .slice(lastIndex)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (textAfter) {
      sendQueue.push({ type: "text", content: textAfter });
    }

    debugLog(`[qqbot] sendText: Send queue: ${sendQueue.map((item) => item.type).join(" -> ")}`);

    // Send queue items in order.
    const mediaTarget = buildMediaTarget({ to, account, replyToId }, "[qqbot:sendText]");
    let lastResult: OutboundResult = { channel: "qqbot" };

    for (const item of sendQueue) {
      try {
        if (item.type === "text") {
          if (replyToId) {
            const accessToken = await getToken(account);
            const target = parseTarget(to);
            if (target.type === "c2c") {
              const result = await sendC2CMessage(
                account.appId,
                accessToken,
                target.id,
                item.content,
                replyToId,
              );
              recordMessageReply(replyToId);
              lastResult = {
                channel: "qqbot",
                messageId: result.id,
                timestamp: result.timestamp,
                refIdx: result.ext_info?.ref_idx,
              };
            } else if (target.type === "group") {
              const result = await sendGroupMessage(
                account.appId,
                accessToken,
                target.id,
                item.content,
                replyToId,
              );
              recordMessageReply(replyToId);
              lastResult = {
                channel: "qqbot",
                messageId: result.id,
                timestamp: result.timestamp,
                refIdx: result.ext_info?.ref_idx,
              };
            } else {
              const result = await sendChannelMessage(
                accessToken,
                target.id,
                item.content,
                replyToId,
              );
              recordMessageReply(replyToId);
              lastResult = {
                channel: "qqbot",
                messageId: result.id,
                timestamp: result.timestamp,
                refIdx: getRefIdx(result),
              };
            }
          } else {
            const accessToken = await getToken(account);
            const target = parseTarget(to);
            if (target.type === "c2c") {
              const result = await sendProactiveC2CMessage(
                account.appId,
                accessToken,
                target.id,
                item.content,
              );
              lastResult = {
                channel: "qqbot",
                messageId: result.id,
                timestamp: result.timestamp,
                refIdx: getRefIdx(result),
              };
            } else if (target.type === "group") {
              const result = await sendProactiveGroupMessage(
                account.appId,
                accessToken,
                target.id,
                item.content,
              );
              lastResult = {
                channel: "qqbot",
                messageId: result.id,
                timestamp: result.timestamp,
                refIdx: getRefIdx(result),
              };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, item.content);
              lastResult = {
                channel: "qqbot",
                messageId: result.id,
                timestamp: result.timestamp,
                refIdx: getRefIdx(result),
              };
            }
          }
          debugLog(`[qqbot] sendText: Sent text part: ${item.content.slice(0, 30)}...`);
        } else if (item.type === "image") {
          lastResult = await sendPhoto(mediaTarget, item.content);
        } else if (item.type === "voice") {
          lastResult = await sendVoice(
            mediaTarget,
            item.content,
            undefined,
            account.config?.audioFormatPolicy?.transcodeEnabled !== false,
          );
        } else if (item.type === "video") {
          lastResult = await sendVideoMsg(mediaTarget, item.content);
        } else if (item.type === "file") {
          lastResult = await sendDocument(mediaTarget, item.content);
        } else if (item.type === "media") {
          // Auto-route qqmedia based on the file extension.
          lastResult = await sendMedia({
            to,
            text: "",
            mediaUrl: item.content,
            accountId: account.accountId,
            replyToId,
            account,
          });
        }
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        debugError(`[qqbot] sendText: Failed to send ${item.type}: ${errMsg}`);
        lastResult = { channel: "qqbot", error: errMsg };
      }
    }

    return lastResult;
  }

  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      debugError("[qqbot] sendText error: proactive message content cannot be empty");
      return {
        channel: "qqbot",
        error: "Proactive messages require non-empty content (--message cannot be empty)",
      };
    }
    if (fallbackToProactive) {
      debugLog(
        `[qqbot] sendText: [fallback] sending proactive message to ${to}, length=${text.length}`,
      );
    } else {
      debugLog(`[qqbot] sendText: sending proactive message to ${to}, length=${text.length}`);
    }
  }

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    debugLog("[qqbot] sendText target:", JSON.stringify(target));

    if (!replyToId) {
      let outResult: OutboundResult;
      if (target.type === "c2c") {
        const result = await sendProactiveC2CMessage(account.appId, accessToken, target.id, text);
        outResult = {
          channel: "qqbot",
          messageId: result.id,
          timestamp: result.timestamp,
          refIdx: getRefIdx(result),
        };
      } else if (target.type === "group") {
        const result = await sendProactiveGroupMessage(account.appId, accessToken, target.id, text);
        outResult = {
          channel: "qqbot",
          messageId: result.id,
          timestamp: result.timestamp,
          refIdx: getRefIdx(result),
        };
      } else {
        const result = await sendChannelMessage(accessToken, target.id, text);
        outResult = {
          channel: "qqbot",
          messageId: result.id,
          timestamp: result.timestamp,
          refIdx: getRefIdx(result),
        };
      }
      return outResult;
    }

    if (target.type === "c2c") {
      const result = await sendC2CMessage(account.appId, accessToken, target.id, text, replyToId);
      recordMessageReply(replyToId);
      return {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        refIdx: result.ext_info?.ref_idx,
      };
    } else if (target.type === "group") {
      const result = await sendGroupMessage(account.appId, accessToken, target.id, text, replyToId);
      recordMessageReply(replyToId);
      return {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        refIdx: result.ext_info?.ref_idx,
      };
    } else {
      const result = await sendChannelMessage(accessToken, target.id, text, replyToId);
      recordMessageReply(replyToId);
      return {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        refIdx: getRefIdx(result),
      };
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    return { channel: "qqbot", error: message };
  }
}

/** Send a proactive message without a replyToId. */
export async function sendProactiveMessage(
  account: ResolvedQQBotAccount,
  to: string,
  text: string,
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();

  if (!account.appId || !account.clientSecret) {
    const errorMsg = "QQBot not configured (missing appId or clientSecret)";
    debugError(`[${timestamp}] [qqbot] sendProactiveMessage: ${errorMsg}`);
    return { channel: "qqbot", error: errorMsg };
  }

  debugLog(
    `[${timestamp}] [qqbot] sendProactiveMessage: starting, to=${to}, text length=${text.length}, accountId=${account.accountId}`,
  );

  try {
    debugLog(
      `[${timestamp}] [qqbot] sendProactiveMessage: getting access token for appId=${account.appId}`,
    );
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    debugLog(`[${timestamp}] [qqbot] sendProactiveMessage: parsing target=${to}`);
    const target = parseTarget(to);
    debugLog(
      `[${timestamp}] [qqbot] sendProactiveMessage: target parsed, type=${target.type}, id=${target.id}`,
    );

    let outResult: OutboundResult;
    if (target.type === "c2c") {
      debugLog(
        `[${timestamp}] [qqbot] sendProactiveMessage: sending proactive C2C message to user=${target.id}`,
      );
      const result = await sendProactiveC2CMessage(account.appId, accessToken, target.id, text);
      debugLog(
        `[${timestamp}] [qqbot] sendProactiveMessage: proactive C2C message sent successfully, messageId=${result.id}`,
      );
      outResult = {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        refIdx: getRefIdx(result),
      };
    } else if (target.type === "group") {
      debugLog(
        `[${timestamp}] [qqbot] sendProactiveMessage: sending proactive group message to group=${target.id}`,
      );
      const result = await sendProactiveGroupMessage(account.appId, accessToken, target.id, text);
      debugLog(
        `[${timestamp}] [qqbot] sendProactiveMessage: proactive group message sent successfully, messageId=${result.id}`,
      );
      outResult = {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        refIdx: getRefIdx(result),
      };
    } else {
      debugLog(
        `[${timestamp}] [qqbot] sendProactiveMessage: sending channel message to channel=${target.id}`,
      );
      const result = await sendChannelMessage(accessToken, target.id, text);
      debugLog(
        `[${timestamp}] [qqbot] sendProactiveMessage: channel message sent successfully, messageId=${result.id}`,
      );
      outResult = {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        refIdx: getRefIdx(result),
      };
    }
    return outResult;
  } catch (err) {
    const errorMessage = formatErrorMessage(err);
    debugError(`[${timestamp}] [qqbot] sendProactiveMessage: error: ${errorMessage}`);
    debugError(
      `[${timestamp}] [qqbot] sendProactiveMessage: error stack: ${err instanceof Error ? err.stack : "No stack trace"}`,
    );
    return { channel: "qqbot", error: errorMessage };
  }
}

/** Send rich media, auto-routing by media type and source. */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mimeType } = ctx;

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }
  if (!ctx.mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }
  const resolvedMediaPath = resolveOutboundMediaPath(ctx.mediaUrl, "[qqbot:sendMedia]", "media", {
    allowMissingLocalPath: true,
  });
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaUrl = resolvedMediaPath.mediaPath;

  const target = buildMediaTarget({ to, account, replyToId }, "[qqbot:sendMedia]");

  // Dispatch by type, preferring MIME and falling back to the file extension.
  // Individual send* helpers already handle direct URL upload vs. download fallback.
  if (isAudioFile(mediaUrl, mimeType)) {
    const formats =
      account.config?.audioFormatPolicy?.uploadDirectFormats ??
      account.config?.voiceDirectUploadFormats;
    const transcodeEnabled = account.config?.audioFormatPolicy?.transcodeEnabled !== false;
    const result = await sendVoice(target, mediaUrl, formats, transcodeEnabled);
    if (!result.error) {
      if (text?.trim()) {
        await sendTextAfterMedia(target, text);
      }
      return result;
    }
    // Preserve the voice error and fall back to file send.
    const voiceError = result.error;
    debugWarn(`[qqbot] sendMedia: sendVoice failed (${voiceError}), falling back to sendDocument`);
    const fallback = await sendDocument(target, mediaUrl);
    if (!fallback.error) {
      if (text?.trim()) {
        await sendTextAfterMedia(target, text);
      }
      return fallback;
    }
    return { channel: "qqbot", error: `voice: ${voiceError} | fallback file: ${fallback.error}` };
  }

  if (isVideoFile(mediaUrl, mimeType)) {
    const result = await sendVideoMsg(target, mediaUrl);
    if (!result.error && text?.trim()) {
      await sendTextAfterMedia(target, text);
    }
    return result;
  }

  // Non-image, non-audio, and non-video media fall back to file send.
  if (
    !isImageFile(mediaUrl, mimeType) &&
    !isAudioFile(mediaUrl, mimeType) &&
    !isVideoFile(mediaUrl, mimeType)
  ) {
    const result = await sendDocument(target, mediaUrl);
    if (!result.error && text?.trim()) {
      await sendTextAfterMedia(target, text);
    }
    return result;
  }

  // Default to image handling. sendPhoto already contains URL fallback logic.
  const result = await sendPhoto(target, mediaUrl);
  if (!result.error && text?.trim()) {
    await sendTextAfterMedia(target, text);
  }
  return result;
}

/** Send text after media when the transport supports a follow-up text message. */
async function sendTextAfterMedia(ctx: MediaTargetContext, text: string): Promise<void> {
  try {
    const token = await getToken(ctx.account);
    if (ctx.targetType === "c2c") {
      await sendC2CMessage(ctx.account.appId, token, ctx.targetId, text, ctx.replyToId);
    } else if (ctx.targetType === "group") {
      await sendGroupMessage(ctx.account.appId, token, ctx.targetId, text, ctx.replyToId);
    } else if (ctx.targetType === "channel") {
      await sendChannelMessage(token, ctx.targetId, text, ctx.replyToId);
    } else if (ctx.targetType === "dm") {
      await sendDmMessage(token, ctx.targetId, text, ctx.replyToId);
    }
  } catch (err) {
    debugError(
      `[qqbot] sendTextAfterMedia failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
    );
  }
}

/** Extract a lowercase extension from a path or URL, ignoring query and hash segments. */
function getCleanExt(filePath: string): string {
  const cleanPath = filePath.split("?")[0].split("#")[0];
  return normalizeLowercaseStringOrEmpty(path.extname(cleanPath));
}

/** Check whether a file is an image using MIME first and extension as fallback. */
function isImageFile(filePath: string, mimeType?: string): boolean {
  if (mimeType) {
    if (mimeType.startsWith("image/")) {
      return true;
    }
  }
  const ext = getCleanExt(filePath);
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
}

/** Check whether a file or URL is a video using MIME first and extension as fallback. */
function isVideoFile(filePath: string, mimeType?: string): boolean {
  if (mimeType) {
    if (mimeType.startsWith("video/")) {
      return true;
    }
  }
  const ext = getCleanExt(filePath);
  return [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"].includes(ext);
}

/**
 * Send a message emitted by an OpenClaw cron task.
 *
 * Cron output may be either:
 * 1. A `QQBOT_CRON:{base64}` structured payload that includes target metadata.
 * 2. Plain text that should be sent directly to the provided fallback target.
 *
 * @param account Resolved account configuration.
 * @param to Fallback target address when the payload does not include one.
 * @param message Message content, either `QQBOT_CRON:` payload or plain text.
 * @returns Send result.
 *
 * @example
 * ```typescript
 * // Structured payload
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",
 *   "QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs..."
 * );
 *
 * // Plain text
 * const result = await sendCronMessage(account, "user_openid", "This is a plain reminder message.");
 * ```
 */
export async function sendCronMessage(
  account: ResolvedQQBotAccount,
  to: string,
  message: string,
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  debugLog(`[${timestamp}] [qqbot] sendCronMessage: to=${to}, message length=${message.length}`);

  // Detect `QQBOT_CRON:` structured payloads first.
  const cronResult = decodeCronPayload(message);

  if (cronResult.isCronPayload) {
    if (cronResult.error) {
      debugError(
        `[${timestamp}] [qqbot] sendCronMessage: cron payload decode error: ${cronResult.error}`,
      );
      return {
        channel: "qqbot",
        error: `Failed to decode cron payload: ${cronResult.error}`,
      };
    }

    if (cronResult.payload) {
      const payload = cronResult.payload;
      debugLog(
        `[${timestamp}] [qqbot] sendCronMessage: decoded cron payload, targetType=${payload.targetType}, targetAddress=${payload.targetAddress}, content length=${payload.content.length}`,
      );

      // Prefer the target encoded in the structured payload.
      const targetTo =
        payload.targetType === "group" ? `group:${payload.targetAddress}` : payload.targetAddress;

      debugLog(
        `[${timestamp}] [qqbot] sendCronMessage: sending proactive message to targetTo=${targetTo}`,
      );

      // Send the reminder content.
      const result = await sendProactiveMessage(account, targetTo, payload.content);

      if (result.error) {
        debugError(
          `[${timestamp}] [qqbot] sendCronMessage: proactive message failed, error=${result.error}`,
        );
      } else {
        debugLog(`[${timestamp}] [qqbot] sendCronMessage: proactive message sent successfully`);
      }

      return result;
    }
  }

  // Fall back to plain text handling when the payload is not structured.
  debugLog(`[${timestamp}] [qqbot] sendCronMessage: plain text message, sending to ${to}`);
  return await sendProactiveMessage(account, to, message);
}
