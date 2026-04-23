import * as fs from "node:fs";
import * as path from "node:path";
import { formatErrorMessage } from "../utils/format.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../utils/string-normalize.js";

// ---- Injected audio-convert dependencies ----

/** Audio conversion interface — implemented by the upper-layer audio-convert module. */
export interface OutboundAudioAdapter {
  audioFileToSilkBase64(
    audioPath: string,
    directUploadFormats?: string[],
  ): Promise<string | undefined>;
  isAudioFile(pathOrUrl: string, mimeType?: string): boolean;
  shouldTranscodeVoice(filePath: string): boolean;
  waitForFile(filePath: string, maxWaitMs?: number): Promise<number>;
}

let _audioAdapter: OutboundAudioAdapter | null = null;
let _audioAdapterFactory: (() => OutboundAudioAdapter) | null = null;

/** Register the audio conversion adapter — called by gateway startup. */
export function registerOutboundAudioAdapter(adapter: OutboundAudioAdapter): void {
  _audioAdapter = adapter;
}

/** Register a factory that creates the adapter on first access (lazy init). */
export function registerOutboundAudioAdapterFactory(factory: () => OutboundAudioAdapter): void {
  _audioAdapterFactory = factory;
}

function getAudio(): OutboundAudioAdapter {
  if (!_audioAdapter && _audioAdapterFactory) {
    _audioAdapter = _audioAdapterFactory();
  }
  if (!_audioAdapter) {
    throw new Error("OutboundAudioAdapter not registered");
  }
  return _audioAdapter;
}

// Re-alias for use in the file.
function audioFileToSilkBase64(p: string, f?: string[]): Promise<string | undefined> {
  return getAudio().audioFileToSilkBase64(p, f);
}
function isAudioFile(p: string, m?: string): boolean {
  // Safe to return false when adapter is unavailable — this is a type-check
  // function called by sendMedia's dispatch logic before any audio processing.
  try {
    return getAudio().isAudioFile(p, m);
  } catch {
    return false;
  }
}
function shouldTranscodeVoice(p: string): boolean {
  return getAudio().shouldTranscodeVoice(p);
}
function waitForFile(p: string, ms?: number): Promise<number> {
  return getAudio().waitForFile(p, ms);
}
import type { GatewayAccount } from "../types.js";
import {
  checkFileSize,
  downloadFile,
  fileExistsAsync,
  formatFileSize,
  readFileAsync,
} from "../utils/file-utils.js";
import { debugError, debugLog, debugWarn } from "../utils/log.js";
import { normalizeMediaTags } from "../utils/media-tags.js";
import { decodeCronPayload } from "../utils/payload.js";
import {
  getQQBotDataDir,
  getQQBotMediaDir,
  isLocalPath as isLocalFilePath,
  normalizePath,
  resolveQQBotPayloadLocalFilePath,
} from "../utils/platform.js";
import { sanitizeFileName } from "../utils/string-normalize.js";
import {
  isImageFile as coreIsImageFile,
  isVideoFile as coreIsVideoFile,
} from "./media-type-detect.js";
// Bridge to core/ modules — use the canonical implementations from the core
// package so the same logic can be shared with the standalone version.
import { ReplyLimiter, type ReplyLimitResult } from "./reply-limiter.js";
import {
  sendText as senderSendText,
  sendImage as senderSendImage,
  sendVoiceMessage as senderSendVoice,
  sendVideoMessage as senderSendVideo,
  sendFileMessage as senderSendFile,
  initApiConfig,
  accountToCreds,
  type DeliveryTarget,
} from "./sender.js";
import { parseTarget as coreParseTarget } from "./target-parser.js";

// Module-level reply limiter instance (replaces the old Map-based tracker).
const replyLimiter = new ReplyLimiter();

// Limit passive replies per message_id within the QQ Bot reply window.
// Delegated to core/messaging/reply-limiter.ts for cross-version sharing.
const MESSAGE_REPLY_LIMIT = 4;

/** Result of the passive-reply limit check. */
export type { ReplyLimitResult };

/** Check whether a message can still receive a passive reply. */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  return replyLimiter.checkLimit(messageId);
}

/** Record one passive reply against a message. */
export function recordMessageReply(messageId: string): void {
  replyLimiter.record(messageId);
  debugLog(
    `[qqbot] recordMessageReply: ${messageId}, count=${replyLimiter.getStats().totalReplies}`,
  );
}

/** Return reply-tracker stats for diagnostics. */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  return replyLimiter.getStats();
}

/** Return the passive-reply configuration. */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return replyLimiter.getConfig();
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: GatewayAccount;
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
  const parsed = coreParseTarget(to);
  debugLog(`[${timestamp}] [qqbot] parseTarget: ${parsed.type} target, ID=${parsed.id}`);
  return parsed;
}

// Structured media send helpers shared by gateway delivery and sendText.

/** Normalized target information for media sends. */
export interface MediaTargetContext {
  targetType: "c2c" | "group" | "channel" | "dm";
  targetId: string;
  account: GatewayAccount;
  replyToId?: string;
}

/** Build a media target from a normal outbound context. */
function buildMediaTarget(ctx: {
  to: string;
  account: GatewayAccount;
  replyToId?: string | null;
}): MediaTargetContext {
  const target = parseTarget(ctx.to);
  return {
    targetType: target.type,
    targetId: target.id,
    account: ctx.account,
    replyToId: ctx.replyToId ?? undefined,
  };
}

/** Return true when public URLs should be passed through directly. */
function shouldDirectUploadUrl(account: GatewayAccount): boolean {
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

  debugWarn(`blocked local ${mediaKind} path outside QQ Bot media storage`);
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
  const resolvedMediaPath = resolveOutboundMediaPath(imagePath, "image");
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaPath = resolvedMediaPath.mediaPath;
  const isLocal = isLocalFilePath(mediaPath);
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
  const isData = mediaPath.startsWith("data:");

  // Force a local download before upload when direct URL upload is disabled.
  if (isHttp && !shouldDirectUploadUrl(ctx.account)) {
    debugLog(`sendPhoto: urlDirectUpload=false, downloading URL first...`);
    const localFile = await downloadToFallbackDir(mediaPath, "sendPhoto");
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
    debugLog(`sendPhoto: local → Base64 (${formatFileSize(fileBuffer.length)})`);
  } else if (!isHttp && !isData) {
    return { channel: "qqbot", error: `Unsupported image source: ${mediaPath.slice(0, 50)}` };
  }

  try {
    const localPath = isLocal ? mediaPath : undefined;
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };

    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendImage(target, imageUrl, creds, {
        msgId: ctx.replyToId,
        content: undefined,
        localPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    if (isHttp) {
      const r = await senderSendText(target, `![](${mediaPath})`, creds, {
        msgId: ctx.replyToId,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendPhoto: channel does not support local/Base64 images`);
    return { channel: "qqbot", error: "Channel does not support local/Base64 images" };
  } catch (err) {
    const msg = formatErrorMessage(err);

    // Fall back to plugin-managed download + Base64 when QQ fails to fetch the URL directly.
    if (isHttp && !isData) {
      debugWarn(
        `sendPhoto: URL direct upload failed (${msg}), downloading locally and retrying as Base64...`,
      );
      const retryResult = await downloadAndRetrySendPhoto(ctx, mediaPath);
      if (retryResult) {
        return retryResult;
      }
    }

    debugError(`sendPhoto failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Download a remote image locally and retry `sendPhoto` through the local-file path. */
async function downloadAndRetrySendPhoto(
  ctx: MediaTargetContext,
  httpUrl: string,
): Promise<OutboundResult | null> {
  try {
    const downloadDir = getQQBotMediaDir("downloads", "url-fallback");
    const localFile = await downloadFile(httpUrl, downloadDir);
    if (!localFile) {
      debugError(`sendPhoto fallback: download also failed for ${httpUrl.slice(0, 80)}`);
      return null;
    }

    debugLog(`sendPhoto fallback: downloaded → ${localFile}, retrying as Base64`);
    return await sendPhoto(ctx, localFile);
  } catch (err) {
    debugError(`sendPhoto fallback error:`, err);
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
  const resolvedMediaPath = resolveOutboundMediaPath(voicePath, "voice", {
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
        const creds = accountToCreds(ctx.account);
        const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
        if (target.type === "c2c" || target.type === "group") {
          const r = await senderSendVoice(target, creds, {
            voiceUrl: mediaPath,
            msgId: ctx.replyToId,
          });
          return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
        }
        debugLog(`sendVoice: voice not supported in channel`);
        return { channel: "qqbot", error: "Voice not supported in channel" };
      } catch (err) {
        const msg = formatErrorMessage(err);
        debugWarn(
          `sendVoice: URL direct upload failed (${msg}), downloading locally and retrying...`,
        );
      }
    } else {
      debugLog(`sendVoice: urlDirectUpload=false, downloading URL first...`);
    }

    const localFile = await downloadToFallbackDir(mediaPath, "sendVoice");
    if (localFile) {
      return await sendVoiceFromLocal(ctx, localFile, directUploadFormats, transcodeEnabled);
    }
    return { channel: "qqbot", error: `Failed to download audio: ${mediaPath.slice(0, 80)}` };
  }

  return await sendVoiceFromLocal(ctx, mediaPath, directUploadFormats, transcodeEnabled);
}

/** Send voice from a local file. */
async function sendVoiceFromLocal(
  ctx: MediaTargetContext,
  mediaPath: string,
  directUploadFormats: string[] | undefined,
  transcodeEnabled: boolean,
): Promise<OutboundResult> {
  // TTS can still be flushing the file to disk, so wait for a stable file first.
  const fileSize = await waitForFile(mediaPath);
  if (fileSize === 0) {
    return { channel: "qqbot", error: "Voice generate failed" };
  }

  // Re-check containment after the file appears to prevent symlink-race escapes.
  const safeMediaPath = resolveQQBotPayloadLocalFilePath(mediaPath);
  if (!safeMediaPath) {
    debugWarn(`sendVoice: blocked local voice path outside QQ Bot media storage`);
    return { channel: "qqbot", error: "Voice path must be inside QQ Bot media storage" };
  }

  const needsTranscode = shouldTranscodeVoice(safeMediaPath);

  if (needsTranscode && !transcodeEnabled) {
    const ext = normalizeLowercaseStringOrEmpty(path.extname(safeMediaPath));
    debugLog(
      `sendVoice: transcode disabled, format ${ext} needs transcode, returning error for fallback`,
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
      debugLog(`sendVoice: SILK conversion failed, uploading raw (${formatFileSize(buf.length)})`);
    } else {
      debugLog(`sendVoice: SILK ready (${fileSize} bytes)`);
    }

    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };

    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendVoice(target, creds, {
        voiceBase64: uploadBase64,
        msgId: ctx.replyToId,
        filePath: safeMediaPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendVoice: voice not supported in channel`);
    return { channel: "qqbot", error: "Voice not supported in channel" };
  } catch (err) {
    const msg = formatErrorMessage(err);
    debugError(`sendVoice (local) failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send video from either a public URL or a local file. */
export async function sendVideoMsg(
  ctx: MediaTargetContext,
  videoPath: string,
): Promise<OutboundResult> {
  const resolvedMediaPath = resolveOutboundMediaPath(videoPath, "video");
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaPath = resolvedMediaPath.mediaPath;
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");

  if (isHttp && !shouldDirectUploadUrl(ctx.account)) {
    debugLog(`sendVideoMsg: urlDirectUpload=false, downloading URL first...`);
    const localFile = await downloadToFallbackDir(mediaPath, "sendVideoMsg");
    if (localFile) {
      return await sendVideoFromLocal(ctx, localFile);
    }
    return { channel: "qqbot", error: `Failed to download video: ${mediaPath.slice(0, 80)}` };
  }

  try {
    if (isHttp) {
      const creds = accountToCreds(ctx.account);
      const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
      if (target.type === "c2c" || target.type === "group") {
        const r = await senderSendVideo(target, creds, {
          videoUrl: mediaPath,
          msgId: ctx.replyToId,
        });
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
      debugLog(`sendVideoMsg: video not supported in channel`);
      return { channel: "qqbot", error: "Video not supported in channel" };
    }

    return await sendVideoFromLocal(ctx, mediaPath);
  } catch (err) {
    const msg = formatErrorMessage(err);

    // If direct URL upload fails, retry through a local download path.
    if (isHttp) {
      debugWarn(
        `sendVideoMsg: URL direct upload failed (${msg}), downloading locally and retrying as Base64...`,
      );
      const localFile = await downloadToFallbackDir(mediaPath, "sendVideoMsg");
      if (localFile) {
        return await sendVideoFromLocal(ctx, localFile);
      }
    }

    debugError(`sendVideoMsg failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send video from a local file. */
async function sendVideoFromLocal(
  ctx: MediaTargetContext,
  mediaPath: string,
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
  debugLog(`sendVideoMsg: local video (${formatFileSize(fileBuffer.length)})`);

  try {
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendVideo(target, creds, {
        videoBase64,
        msgId: ctx.replyToId,
        localPath: mediaPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendVideoMsg: video not supported in channel`);
    return { channel: "qqbot", error: "Video not supported in channel" };
  } catch (err) {
    const msg = formatErrorMessage(err);
    debugError(`sendVideoMsg (local) failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send a file from a local path or public URL. */
export async function sendDocument(
  ctx: MediaTargetContext,
  filePath: string,
  options: SendDocumentOptions = {},
): Promise<OutboundResult> {
  const extraLocalRoots = options.allowQQBotDataDownloads
    ? [getQQBotDataDir("downloads")]
    : undefined;
  const resolvedMediaPath = resolveOutboundMediaPath(filePath, "file", {
    extraLocalRoots,
  });
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaPath = resolvedMediaPath.mediaPath;
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
  const fileName = sanitizeFileName(path.basename(mediaPath));

  if (isHttp && !shouldDirectUploadUrl(ctx.account)) {
    debugLog(`sendDocument: urlDirectUpload=false, downloading URL first...`);
    const localFile = await downloadToFallbackDir(mediaPath, "sendDocument");
    if (localFile) {
      return await sendDocumentFromLocal(ctx, localFile);
    }
    return { channel: "qqbot", error: `Failed to download file: ${mediaPath.slice(0, 80)}` };
  }

  try {
    if (isHttp) {
      const creds = accountToCreds(ctx.account);
      const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
      if (target.type === "c2c" || target.type === "group") {
        const r = await senderSendFile(target, creds, {
          fileUrl: mediaPath,
          msgId: ctx.replyToId,
          fileName,
        });
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
      debugLog(`sendDocument: file not supported in channel`);
      return { channel: "qqbot", error: "File not supported in channel" };
    }

    return await sendDocumentFromLocal(ctx, mediaPath);
  } catch (err) {
    const msg = formatErrorMessage(err);

    // If direct URL upload fails, retry through a local download path.
    if (isHttp) {
      debugWarn(
        `sendDocument: URL direct upload failed (${msg}), downloading locally and retrying as Base64...`,
      );
      const localFile = await downloadToFallbackDir(mediaPath, "sendDocument");
      if (localFile) {
        return await sendDocumentFromLocal(ctx, localFile);
      }
    }

    debugError(`sendDocument failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send a file from local storage. */
async function sendDocumentFromLocal(
  ctx: MediaTargetContext,
  mediaPath: string,
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
  debugLog(`sendDocument: local file (${formatFileSize(fileBuffer.length)})`);

  try {
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendFile(target, creds, {
        fileBase64,
        msgId: ctx.replyToId,
        fileName,
        localFilePath: mediaPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendDocument: file not supported in channel`);
    return { channel: "qqbot", error: "File not supported in channel" };
  } catch (err) {
    const msg = formatErrorMessage(err);
    debugError(`sendDocument (local) failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Download a remote file into the fallback media directory. */
async function downloadToFallbackDir(httpUrl: string, caller: string): Promise<string | null> {
  try {
    const downloadDir = getQQBotMediaDir("downloads", "url-fallback");
    const localFile = await downloadFile(httpUrl, downloadDir);
    if (!localFile) {
      debugError(`${caller} fallback: download also failed for ${httpUrl.slice(0, 80)}`);
      return null;
    }
    debugLog(`${caller} fallback: downloaded → ${localFile}`);
    return localFile;
  } catch (err) {
    debugError(`${caller} fallback download error:`, err);
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

  initApiConfig(account.appId, { markdownSupport: account.markdownSupport });

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
            return String.fromCharCode(Number.parseInt(octal, 8));
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
    const mediaTarget = buildMediaTarget({ to, account, replyToId });
    let lastResult: OutboundResult = { channel: "qqbot" };

    for (const item of sendQueue) {
      try {
        if (item.type === "text") {
          const target = parseTarget(to);
          const creds = accountToCreds(account);
          const deliveryTarget: DeliveryTarget = {
            type: target.type === "channel" ? "channel" : target.type,
            id: target.id,
          };
          const result = await senderSendText(deliveryTarget, item.content, creds, {
            msgId: replyToId ?? undefined,
          });
          if (replyToId) {
            recordMessageReply(replyToId);
          }
          lastResult = {
            channel: "qqbot",
            messageId: result.id,
            timestamp: result.timestamp,
            refIdx: result.ext_info?.ref_idx,
          };
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
    const target = parseTarget(to);
    const creds = accountToCreds(account);
    const deliveryTarget: DeliveryTarget = {
      type: target.type === "channel" ? "channel" : target.type,
      id: target.id,
    };
    debugLog("[qqbot] sendText target:", JSON.stringify(target));

    const result = await senderSendText(deliveryTarget, text, creds, {
      msgId: replyToId ?? undefined,
    });
    if (replyToId) {
      recordMessageReply(replyToId);
    }
    return {
      channel: "qqbot",
      messageId: result.id,
      timestamp: result.timestamp,
      refIdx: result.ext_info?.ref_idx,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    return { channel: "qqbot", error: message };
  }
}

/** Send rich media, auto-routing by media type and source. */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mimeType } = ctx;

  initApiConfig(account.appId, { markdownSupport: account.markdownSupport });

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }
  if (!ctx.mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }
  const resolvedMediaPath = resolveOutboundMediaPath(ctx.mediaUrl, "media", {
    allowMissingLocalPath: true,
  });
  if (!resolvedMediaPath.ok) {
    return { channel: "qqbot", error: resolvedMediaPath.error };
  }
  const mediaUrl = resolvedMediaPath.mediaPath;

  const target = buildMediaTarget({ to, account, replyToId });

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
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
    await senderSendText(target, text, creds, { msgId: ctx.replyToId });
  } catch (err) {
    debugError(`[qqbot] sendTextAfterMedia failed: ${formatErrorMessage(err)}`);
  }
}

// Media type detection delegated to core/outbound/media-type-detect.ts.
// Re-alias for backward compatibility within this file.
const isImageFile = coreIsImageFile;
const isVideoFile = coreIsVideoFile;

/**
 * Send a proactive (no reply context) text message to a qualified target.
 *
 * Thin wrapper around {@link sendText} for callers that have a fully-qualified
 * target string (e.g. `"qqbot:c2c:<openid>"`) and a {@link GatewayAccount},
 * and do not want to manage access tokens or delivery-target parsing manually.
 *
 * @param account Resolved gateway account.
 * @param to Fully-qualified target address (`qqbot:c2c:<openid>`, `qqbot:group:<id>`, etc.).
 * @param content Message content.
 */
export async function sendProactiveMessage(
  account: GatewayAccount,
  to: string,
  content: string,
): Promise<OutboundResult> {
  return sendText({ account, to, text: content });
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
  account: GatewayAccount,
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
      const result = await sendText({ account, to: targetTo, text: payload.content });

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
  return await sendText({ account, to, text: message });
}
