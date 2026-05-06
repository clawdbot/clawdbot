/**
 * Low-level outbound media sends (photo, voice, video, document) and path resolution.
 */

import path from "node:path";
import {
  pathExistsSync,
  resolveLocalPathFromRootsSync,
} from "openclaw/plugin-sdk/security-runtime";
import type { GatewayAccount } from "../types.js";
import { MediaFileType } from "../types.js";
import {
  checkFileSize,
  downloadFile,
  fileExistsAsync,
  formatFileSize,
  getImageMimeType,
  getMaxUploadSize,
  readFileAsync,
} from "../utils/file-utils.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugError, debugLog, debugWarn } from "../utils/log.js";
import {
  getQQBotDataDir,
  getQQBotMediaDir,
  isLocalPath as isLocalFilePath,
  normalizePath,
  resolveQQBotPayloadLocalFilePath,
} from "../utils/platform.js";
import { normalizeLowercaseStringOrEmpty, sanitizeFileName } from "../utils/string-normalize.js";
import { audioFileToSilkBase64, shouldTranscodeVoice, waitForFile } from "./outbound-audio-port.js";
import {
  buildDailyLimitExceededResult,
  buildFileTooLargeResult,
} from "./outbound-result-helpers.js";
import type { MediaTargetContext, OutboundResult } from "./outbound-types.js";
import {
  accountToCreds,
  sendMedia as senderSendMedia,
  sendText as senderSendText,
  UploadDailyLimitExceededError,
  type DeliveryTarget,
} from "./sender.js";
import { parseTarget as coreParseTarget } from "./target-parser.js";

/** Parse a qqbot target into a structured delivery target. */
export function parseTarget(to: string): { type: "c2c" | "group" | "channel"; id: string } {
  const timestamp = new Date().toISOString();
  debugLog(`[${timestamp}] [qqbot] parseTarget: input=${to}`);
  const parsed = coreParseTarget(to);
  debugLog(`[${timestamp}] [qqbot] parseTarget: ${parsed.type} target, ID=${parsed.id}`);
  return parsed;
}

// Structured media send helpers shared by gateway delivery and sendText.

/** Build a media target from a normal outbound context. */
export function buildMediaTarget(ctx: {
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

function resolveMissingPathWithinMediaRoot(normalizedPath: string): string | null {
  const resolvedCandidate = path.resolve(normalizedPath);
  if (pathExistsSync(resolvedCandidate)) {
    return null;
  }
  return (
    resolveLocalPathFromRootsSync({
      filePath: resolvedCandidate,
      roots: [getQQBotMediaDir()],
      label: "QQ Bot media storage",
      allowMissing: true,
    })?.path ?? null
  );
}

function resolveExistingPathWithinRoots(
  normalizedPath: string,
  allowedRoots: readonly string[],
): string | null {
  return (
    resolveLocalPathFromRootsSync({
      filePath: normalizedPath,
      roots: allowedRoots,
      label: "QQ Bot local roots",
    })?.path ?? null
  );
}

export function resolveOutboundMediaPath(
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
      return await sendPhotoFromLocal(ctx, localFile);
    }
    return { channel: "qqbot", error: `Failed to download image: ${mediaPath.slice(0, 80)}` };
  }

  if (isLocal) {
    return await sendPhotoFromLocal(ctx, mediaPath);
  }

  if (!isHttp && !isData) {
    return { channel: "qqbot", error: `Unsupported image source: ${mediaPath.slice(0, 50)}` };
  }

  // Remote URL or data: URL — try direct upload first, fall back to
  // download-then-local on failure.
  try {
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };

    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendMedia({
        target,
        creds,
        kind: "image",
        source: { url: mediaPath },
        msgId: ctx.replyToId,
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

    // Fall back to plugin-managed download + local upload when QQ fails to
    // fetch the URL directly. One-shot, non-recursive.
    if (isHttp && !isData) {
      debugWarn(
        `sendPhoto: URL direct upload failed (${msg}), downloading locally and retrying as Base64...`,
      );
      const localFile = await downloadToFallbackDir(mediaPath, "sendPhoto");
      if (localFile) {
        return await sendPhotoFromLocal(ctx, localFile);
      }
    }

    debugError(`sendPhoto failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/** Send a photo from a validated local file path. */
async function sendPhotoFromLocal(
  ctx: MediaTargetContext,
  mediaPath: string,
): Promise<OutboundResult> {
  if (!(await fileExistsAsync(mediaPath))) {
    return { channel: "qqbot", error: "Image not found" };
  }
  const sizeCheck = checkFileSize(mediaPath, getMaxUploadSize(MediaFileType.IMAGE));
  if (!sizeCheck.ok) {
    return buildFileTooLargeResult(MediaFileType.IMAGE, sizeCheck.size);
  }
  const mimeType = getImageMimeType(mediaPath);
  if (!mimeType) {
    const ext = normalizeLowercaseStringOrEmpty(path.extname(mediaPath));
    return { channel: "qqbot", error: `Unsupported image format: ${ext}` };
  }
  debugLog(`sendPhoto: local (${formatFileSize(sizeCheck.size)})`);

  try {
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };

    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendMedia({
        target,
        creds,
        kind: "image",
        source: { localPath: mediaPath },
        msgId: ctx.replyToId,
        localPathForMeta: mediaPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendPhoto: channel does not support local images`);
    return { channel: "qqbot", error: "Channel does not support local/Base64 images" };
  } catch (err) {
    if (err instanceof UploadDailyLimitExceededError) {
      debugError(`sendPhoto (local): daily upload quota exceeded`);
      return buildDailyLimitExceededResult(err);
    }
    const msg = formatErrorMessage(err);
    debugError(`sendPhoto (local) failed: ${msg}`);
    return { channel: "qqbot", error: msg };
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
          const r = await senderSendMedia({
            target,
            creds,
            kind: "voice",
            source: { url: mediaPath },
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
  if (fileSize > getMaxUploadSize(MediaFileType.VOICE)) {
    return buildFileTooLargeResult(MediaFileType.VOICE, fileSize);
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
      const r = await senderSendMedia({
        target,
        creds,
        kind: "voice",
        source: { base64: uploadBase64 },
        msgId: ctx.replyToId,
        localPathForMeta: safeMediaPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendVoice: voice not supported in channel`);
    return { channel: "qqbot", error: "Voice not supported in channel" };
  } catch (err) {
    if (err instanceof UploadDailyLimitExceededError) {
      debugError(`sendVoice (local): daily upload quota exceeded`);
      return buildDailyLimitExceededResult(err);
    }
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
        const r = await senderSendMedia({
          target,
          creds,
          kind: "video",
          source: { url: mediaPath },
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
  const sizeCheck = checkFileSize(mediaPath, getMaxUploadSize(MediaFileType.VIDEO));
  if (!sizeCheck.ok) {
    return buildFileTooLargeResult(MediaFileType.VIDEO, sizeCheck.size);
  }
  debugLog(`sendVideoMsg: local video (${formatFileSize(sizeCheck.size)})`);

  try {
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendMedia({
        target,
        creds,
        kind: "video",
        source: { localPath: mediaPath },
        msgId: ctx.replyToId,
        localPathForMeta: mediaPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendVideoMsg: video not supported in channel`);
    return { channel: "qqbot", error: "Video not supported in channel" };
  } catch (err) {
    if (err instanceof UploadDailyLimitExceededError) {
      debugError(`sendVideoMsg (local): daily upload quota exceeded`);
      return buildDailyLimitExceededResult(err);
    }
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
        const r = await senderSendMedia({
          target,
          creds,
          kind: "file",
          source: { url: mediaPath },
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
  const sizeCheck = checkFileSize(mediaPath, getMaxUploadSize(MediaFileType.FILE));
  if (!sizeCheck.ok) {
    return buildFileTooLargeResult(MediaFileType.FILE, sizeCheck.size);
  }
  if (sizeCheck.size === 0) {
    return { channel: "qqbot", error: `File is empty: ${mediaPath}` };
  }
  debugLog(`sendDocument: local file (${formatFileSize(sizeCheck.size)})`);

  try {
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
    if (target.type === "c2c" || target.type === "group") {
      const r = await senderSendMedia({
        target,
        creds,
        kind: "file",
        source: { localPath: mediaPath },
        msgId: ctx.replyToId,
        fileName,
        localPathForMeta: mediaPath,
      });
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
    debugLog(`sendDocument: file not supported in channel`);
    return { channel: "qqbot", error: "File not supported in channel" };
  } catch (err) {
    if (err instanceof UploadDailyLimitExceededError) {
      debugError(`sendDocument (local): daily upload quota exceeded`);
      return buildDailyLimitExceededResult(err);
    }
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
