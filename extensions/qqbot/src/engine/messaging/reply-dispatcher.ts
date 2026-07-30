/**
 * Reply dispatcher — structured payload handling and text routing.
 *
 * Uses the unified `sender.ts` business function layer for all message
 * sending. TTS is injected via `ReplyDispatcherDeps`.
 */

import crypto from "node:crypto";
import path from "node:path";
import { resolveLocalPathFromRootsSync } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { MediaFileType, type GatewayAccount } from "../types.js";
import { formatFileSize, getImageMimeType, getMaxUploadSize } from "../utils/file-utils.js";
import { formatErrorMessage } from "../utils/format.js";
import {
  parseQQBotPayload,
  encodePayloadForCron,
  isCronReminderPayload,
  isMediaPayload,
  type MediaPayload,
} from "../utils/payload.js";
import { normalizePath } from "../utils/platform.js";
import { normalizeLowercaseStringOrEmpty } from "../utils/string-normalize.js";
import { sanitizeFileName } from "../utils/string-normalize.js";
import { openLocalFile } from "./media-source.js";
import {
  resolveOutboundMediaLocalRoots,
  resolveWorkspacePathCandidates,
  resolveWorkspaceScopedLocalRoots,
} from "./outbound-media-path.js";
import type { OutboundMediaAccessContext } from "./outbound-types.js";
import {
  sendText as senderSendText,
  sendMedia as senderSendMedia,
  withTokenRetry,
  buildDeliveryTarget,
  accountToCreds,
} from "./sender.js";
import { resolveTrustedOutboundMediaPath } from "./trusted-media-path.js";

// ---- Injected dependencies ----

/** TTS provider interface — injected from the outer layer. */
interface TTSProvider {
  /** Framework TTS: text → audio file path. */
  textToSpeech(params: {
    text: string;
    cfg: unknown;
    channel: string;
    accountId?: string;
  }): Promise<{
    success: boolean;
    audioPath?: string;
    provider?: string;
    outputFormat?: string;
    error?: string;
  }>;
  /** Convert any audio file to SILK base64. */
  audioFileToSilkBase64(audioPath: string): Promise<string | undefined>;
}

/** Dependencies injected into reply-dispatcher functions. */
export interface ReplyDispatcherDeps {
  tts: TTSProvider;
}

// ---- Exported types ----

interface MessageTarget {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
}

interface ReplyContext extends OutboundMediaAccessContext {
  target: MessageTarget;
  account: GatewayAccount;
  cfg: unknown;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// ---- Token retry (delegated to sender.ts) ----

/** Send a message and retry once if the token appears to have expired. */
export async function sendWithTokenRetry<T>(
  appId: string,
  clientSecret: string,
  sendFn: (token: string) => Promise<T>,
  log?: ReplyContext["log"],
  accountId?: string,
): Promise<T> {
  return withTokenRetry({ appId, clientSecret }, sendFn, log, accountId);
}

// ---- Text routing ----

/** Route a text message to the correct QQ target type. */
async function sendTextToTarget(ctx: ReplyContext, text: string, refIdx?: string): Promise<void> {
  const { target, account } = ctx;
  const deliveryTarget = buildDeliveryTarget(target);
  const creds = accountToCreds(account);
  await withTokenRetry(
    creds,
    async () => {
      await senderSendText(deliveryTarget, text, creds, {
        msgId: target.messageId,
        messageReference: refIdx,
      });
    },
    ctx.log,
    account.accountId,
  );
}

/** Best-effort delivery for error text back to the user. */
export async function sendErrorToTarget(ctx: ReplyContext, errorText: string): Promise<void> {
  try {
    await sendTextToTarget(ctx, errorText);
  } catch (sendErr) {
    ctx.log?.error(`Failed to send error message: ${String(sendErr)}`);
  }
}

// ---- Structured payload handling ----

/**
 * Handle a structured payload prefixed with `QQBOT_PAYLOAD:`.
 * Returns true when the reply was handled here, otherwise false.
 */
export async function handleStructuredPayload(
  ctx: ReplyContext,
  replyText: string,
  recordActivity: () => void,
  deps?: ReplyDispatcherDeps,
): Promise<boolean> {
  const { account: _account, log } = ctx;
  const payloadResult = parseQQBotPayload(replyText);

  if (!payloadResult.isPayload) {
    return false;
  }

  if (payloadResult.error) {
    log?.error(`Payload parse error: ${payloadResult.error}`);
    return true;
  }

  if (!payloadResult.payload) {
    return true;
  }

  const parsedPayload = payloadResult.payload;
  const unknownPayload = payloadResult.payload as unknown;
  log?.info(`Detected structured payload, type: ${parsedPayload.type}`);

  if (isCronReminderPayload(parsedPayload)) {
    log?.debug?.(`Processing cron_reminder payload`);
    const cronMessage = encodePayloadForCron(parsedPayload);
    const confirmText = `⏰ Reminder scheduled. It will be sent at the configured time: "${parsedPayload.content}"`;
    try {
      await sendTextToTarget(ctx, confirmText);
      log?.debug?.(`Cron reminder confirmation sent, cronMessage: ${cronMessage}`);
    } catch (err) {
      log?.error(`Failed to send cron confirmation: ${formatErrorMessage(err)}`);
    }
    recordActivity();
    return true;
  }

  if (isMediaPayload(parsedPayload)) {
    log?.debug?.(`Processing media payload, mediaType: ${parsedPayload.mediaType}`);

    if (parsedPayload.mediaType === "image") {
      await handleImagePayload(ctx, parsedPayload);
    } else if (parsedPayload.mediaType === "audio") {
      await handleAudioPayload(ctx, parsedPayload, deps);
    } else if (parsedPayload.mediaType === "video") {
      await handleVideoPayload(ctx, parsedPayload);
    } else if (parsedPayload.mediaType === "file") {
      await handleFilePayload(ctx, parsedPayload);
    } else {
      log?.error(`Unknown media type: ${JSON.stringify(parsedPayload.mediaType)}`);
    }
    recordActivity();
    return true;
  }

  const payloadType =
    typeof unknownPayload === "object" &&
    unknownPayload !== null &&
    "type" in unknownPayload &&
    typeof unknownPayload.type === "string"
      ? unknownPayload.type
      : "unknown";
  log?.error(`Unknown payload type: ${payloadType}`);
  return true;
}

// ---- Media payload handlers ----

type StructuredPayloadMediaType = "image" | "video" | "file";

function formatMediaTypeLabel(mediaType: StructuredPayloadMediaType): string {
  return mediaType.charAt(0).toUpperCase() + mediaType.slice(1);
}

function validateStructuredPayloadLocalPath(
  ctx: ReplyContext,
  payloadPath: string,
  mediaType: StructuredPayloadMediaType,
): string | null {
  const candidatePaths = resolveWorkspacePathCandidates(
    normalizePath(payloadPath),
    ctx.mediaAccess?.workspaceDir,
  );
  const localRoots = resolveWorkspaceScopedLocalRoots(
    resolveOutboundMediaLocalRoots(ctx),
    ctx.mediaAccess?.workspaceDir,
  );
  const allowMissingHostRead = Boolean(resolveStructuredPayloadReadFile(ctx));
  for (const candidatePath of candidatePaths) {
    const allowedPath = resolveTrustedOutboundMediaPath(candidatePath, {
      allowMissing: allowMissingHostRead,
    });
    if (allowedPath) {
      return allowedPath;
    }

    if (localRoots) {
      const scopedPath = resolveLocalPathFromRootsSync({
        filePath: candidatePath,
        roots: localRoots,
        label: "QQ Bot local roots",
        allowMissing: allowMissingHostRead,
      })?.path;
      if (scopedPath) {
        return scopedPath;
      }
    }
  }

  ctx.log?.error(`Blocked ${mediaType} payload local path outside QQ Bot media storage`);
  return null;
}

function isRemoteHttpUrl(p: string): boolean {
  return /^https?:\/\//i.test(p);
}

function isInlineImageDataUrl(p: string): boolean {
  return /^data:image\/[^;]+;base64,/i.test(p);
}

function resolveStructuredPayloadPath(
  ctx: ReplyContext,
  payload: MediaPayload,
  mediaType: StructuredPayloadMediaType,
): { path: string; isHttpUrl: boolean } | null {
  const originalPath = payload.path ?? "";
  const normalizedPath = normalizePath(originalPath);
  const isHttpUrl = isRemoteHttpUrl(normalizedPath);
  const resolvedPath = isHttpUrl
    ? normalizedPath
    : validateStructuredPayloadLocalPath(ctx, originalPath, mediaType);
  if (!resolvedPath) {
    return null;
  }
  if (!resolvedPath.trim()) {
    ctx.log?.error(
      `[qqbot:${ctx.account.accountId}] ${formatMediaTypeLabel(mediaType)} missing path`,
    );
    return null;
  }
  return { path: resolvedPath, isHttpUrl };
}

function sanitizeForLog(value: string, maxLen = 200): string {
  return truncateUtf16Safe(value.replace(/[\r\n\t]/g, " ").replaceAll("\0", " "), maxLen);
}

function describeMediaTargetForLog(pathValue: string, isHttpUrl: boolean): string {
  if (!isHttpUrl) {
    return "<local-file>";
  }
  try {
    const url = new URL(pathValue);
    url.username = "";
    url.password = "";
    const urlId = crypto.createHash("sha256").update(url.toString()).digest("hex").slice(0, 12);
    return sanitizeForLog(`${url.protocol}//${url.host}#${urlId}`);
  } catch {
    return "<invalid-url>";
  }
}

function resolveStructuredPayloadReadFile(ctx: OutboundMediaAccessContext) {
  return ctx.mediaAccess?.readFile ?? ctx.mediaReadFile;
}

function assertBufferWithinTypeLimit(buffer: Buffer, fileType: MediaFileType): void {
  const maxSize = getMaxUploadSize(fileType);
  if (buffer.length > maxSize) {
    throw new Error(
      `File is too large (${formatFileSize(buffer.length)}); QQ Bot API limit is ${formatFileSize(maxSize)}`,
    );
  }
}

function imageBufferMatchesMime(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const header = buffer.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (mimeType === "image/bmp") {
    return buffer.subarray(0, 2).toString("ascii") === "BM";
  }
  return false;
}

async function readLocalFileForInlineBase64(
  ctx: ReplyContext,
  filePath: string,
  fileType: MediaFileType,
): Promise<Buffer> {
  const mediaReadFile = resolveStructuredPayloadReadFile(ctx);
  if (mediaReadFile) {
    let buffer: Buffer | null = null;
    try {
      buffer = await mediaReadFile(filePath);
    } catch (err) {
      ctx.log?.debug?.(`Structured payload host read failed: ${formatErrorMessage(err)}`);
    }
    if (buffer !== null) {
      assertBufferWithinTypeLimit(buffer, fileType);
      if (buffer.length === 0) {
        throw new Error(`File is empty: ${filePath}`);
      }
      return buffer;
    }
  }
  const opened = await openLocalFile(filePath, { maxSize: getMaxUploadSize(fileType) });
  try {
    return await opened.handle.readFile();
  } finally {
    await opened.close();
  }
}

async function readPayloadFileBuffer(
  ctx: ReplyContext,
  filePath: string,
  fileType: MediaFileType,
): Promise<Buffer | null> {
  const mediaReadFile = resolveStructuredPayloadReadFile(ctx);
  if (!mediaReadFile) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = await mediaReadFile(filePath);
  } catch (err) {
    ctx.log?.debug?.(`Structured payload host read failed: ${formatErrorMessage(err)}`);
    return null;
  }
  assertBufferWithinTypeLimit(buffer, fileType);
  if (buffer.length === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }
  return buffer;
}

async function assertLocalFileWithinTypeLimit(
  filePath: string,
  fileType: MediaFileType,
): Promise<number> {
  const opened = await openLocalFile(filePath, { maxSize: getMaxUploadSize(fileType) });
  try {
    return opened.size;
  } finally {
    await opened.close();
  }
}

async function handleImagePayload(ctx: ReplyContext, payload: MediaPayload): Promise<void> {
  const { target, account, log } = ctx;
  const normalizedPath = normalizePath(payload.path);
  let imageUrl: string | null;
  if (payload.source === "file") {
    imageUrl = validateStructuredPayloadLocalPath(ctx, normalizedPath, "image");
  } else if (isRemoteHttpUrl(normalizedPath) || isInlineImageDataUrl(normalizedPath)) {
    imageUrl = normalizedPath;
  } else {
    log?.error(
      `Image payload URL must use http(s) or data:image/: ${sanitizeForLog(payload.path)}`,
    );
    return;
  }
  if (!imageUrl) {
    return;
  }
  const originalImagePath = payload.source === "file" ? imageUrl : undefined;

  if (payload.source === "file") {
    try {
      const fileBuffer = await readLocalFileForInlineBase64(ctx, imageUrl, MediaFileType.IMAGE);
      const mimeType = getImageMimeType(imageUrl);
      if (!mimeType) {
        const ext = normalizeLowercaseStringOrEmpty(path.extname(imageUrl));
        log?.error(`Unsupported image format: ${ext}`);
        return;
      }
      if (!imageBufferMatchesMime(fileBuffer, mimeType)) {
        throw new Error(`File is not an image: ${imageUrl}`);
      }
      const base64Data = fileBuffer.toString("base64");
      imageUrl = `data:${mimeType};base64,${base64Data}`;
      log?.debug?.(`Converted local image to Base64 (size: ${formatFileSize(fileBuffer.length)})`);
    } catch (readErr) {
      log?.error(
        `Failed to read local image: ${
          readErr instanceof Error ? readErr.message : JSON.stringify(readErr)
        }`,
      );
      return;
    }
  }

  try {
    const deliveryTarget = buildDeliveryTarget(target);
    const creds = accountToCreds(account);

    await withTokenRetry(
      creds,
      async () => {
        if (deliveryTarget.type === "c2c" || deliveryTarget.type === "group") {
          await senderSendMedia({
            target: deliveryTarget,
            creds,
            kind: "image",
            source: { url: imageUrl },
            msgId: target.messageId,
            localPathForMeta: originalImagePath,
          });
        } else if (deliveryTarget.type === "dm") {
          await senderSendText(deliveryTarget, `![](${imageUrl})`, creds, {
            msgId: target.messageId,
          });
        } else {
          await senderSendText(deliveryTarget, `![](${imageUrl})`, creds, {
            msgId: target.messageId,
          });
        }
      },
      log,
      account.accountId,
    );
    log?.debug?.(`Sent image via media payload`);

    if (payload.caption) {
      await sendTextToTarget(ctx, payload.caption);
    }
  } catch (err) {
    log?.error(`Failed to send image: ${formatErrorMessage(err)}`);
  }
}

async function handleAudioPayload(
  ctx: ReplyContext,
  payload: MediaPayload,
  deps?: ReplyDispatcherDeps,
): Promise<void> {
  const ttsText = payload.caption || payload.path;
  await sendTextAsVoiceReply(ctx, ttsText, deps);
}

export async function sendTextAsVoiceReply(
  ctx: ReplyContext,
  text: string | undefined,
  deps?: ReplyDispatcherDeps,
): Promise<boolean> {
  const { target, account, cfg, log } = ctx;
  if (!deps) {
    log?.error(`TTS deps not provided, cannot handle audio payload`);
    return false;
  }
  try {
    const ttsText = text;
    if (!ttsText?.trim()) {
      log?.error(`Voice missing text`);
      return false;
    }

    log?.debug?.(`TTS: "${truncateUtf16Safe(ttsText, 50)}..."`);
    const ttsResult = await deps.tts.textToSpeech({
      text: ttsText,
      cfg,
      channel: "qqbot",
      accountId: account.accountId,
    });
    if (!ttsResult.success || !ttsResult.audioPath) {
      log?.error(`TTS failed: ${ttsResult.error ?? "unknown"}`);
      return false;
    }

    const providerLabel = ttsResult.provider ?? "unknown";
    log?.debug?.(
      `TTS returned: provider=${providerLabel}, format=${ttsResult.outputFormat}, path=${ttsResult.audioPath}`,
    );

    const silkBase64 = await deps.tts.audioFileToSilkBase64(ttsResult.audioPath);
    if (!silkBase64) {
      log?.error(`Failed to convert TTS audio to SILK`);
      return false;
    }
    const silkPath = ttsResult.audioPath;

    log?.debug?.(`TTS done (${providerLabel}), file: ${silkPath}`);

    const deliveryTarget = buildDeliveryTarget(target);
    const creds = accountToCreds(account);

    await withTokenRetry(
      creds,
      async () => {
        if (deliveryTarget.type === "c2c" || deliveryTarget.type === "group") {
          await senderSendMedia({
            target: deliveryTarget,
            creds,
            kind: "voice",
            source: { base64: silkBase64 },
            msgId: target.messageId,
            ttsText,
            localPathForMeta: silkPath,
          });
        } else {
          log?.error(`Voice not supported in ${deliveryTarget.type}, sending text fallback`);
          await senderSendText(deliveryTarget, ttsText, creds, { msgId: target.messageId });
        }
      },
      log,
      account.accountId,
    );
    log?.debug?.(`Voice message sent`);
    return true;
  } catch (err) {
    log?.error(`TTS/voice send failed: ${formatErrorMessage(err)}`);
    return false;
  }
}

async function handleVideoPayload(ctx: ReplyContext, payload: MediaPayload): Promise<void> {
  const { target, account, log } = ctx;
  try {
    const resolved = resolveStructuredPayloadPath(ctx, payload, "video");
    if (!resolved) {
      return;
    }
    const videoPath = resolved.path;
    const isHttpUrl = resolved.isHttpUrl;

    log?.debug?.(`Video send: ${describeMediaTargetForLog(videoPath, isHttpUrl)}`);

    const deliveryTarget = buildDeliveryTarget(target);
    const creds = accountToCreds(account);

    if (deliveryTarget.type !== "c2c" && deliveryTarget.type !== "group") {
      log?.error(`Video not supported in ${deliveryTarget.type}`);
      return;
    }

    await withTokenRetry(
      creds,
      async () => {
        if (isHttpUrl) {
          await senderSendMedia({
            target: deliveryTarget,
            creds,
            kind: "video",
            source: { url: videoPath },
            msgId: target.messageId,
          });
        } else {
          const payloadBuffer = await readPayloadFileBuffer(ctx, videoPath, MediaFileType.VIDEO);
          if (payloadBuffer) {
            await senderSendMedia({
              target: deliveryTarget,
              creds,
              kind: "video",
              source: {
                buffer: payloadBuffer,
                fileName: sanitizeFileName(path.basename(videoPath)),
              },
              msgId: target.messageId,
            });
            return;
          }
          const size = await assertLocalFileWithinTypeLimit(videoPath, MediaFileType.VIDEO);
          log?.debug?.(
            `Video local (${formatFileSize(size)}): ${describeMediaTargetForLog(videoPath, false)}`,
          );
          await senderSendMedia({
            target: deliveryTarget,
            creds,
            kind: "video",
            source: { localPath: videoPath },
            msgId: target.messageId,
            localPathForMeta: videoPath,
          });
        }
      },
      log,
      account.accountId,
    );
    log?.debug?.(`Video message sent`);

    if (payload.caption) {
      await sendTextToTarget(ctx, payload.caption);
    }
  } catch (err) {
    log?.error(`Video send failed: ${formatErrorMessage(err)}`);
  }
}

async function handleFilePayload(ctx: ReplyContext, payload: MediaPayload): Promise<void> {
  const { target, account, log } = ctx;
  try {
    const resolved = resolveStructuredPayloadPath(ctx, payload, "file");
    if (!resolved) {
      return;
    }
    const filePath = resolved.path;
    const isHttpUrl = resolved.isHttpUrl;

    const fileName = sanitizeFileName(path.basename(filePath));
    log?.debug?.(
      `File send: ${describeMediaTargetForLog(filePath, isHttpUrl)} (${isHttpUrl ? "URL" : "local"})`,
    );

    const deliveryTarget = buildDeliveryTarget(target);
    const creds = accountToCreds(account);

    if (deliveryTarget.type !== "c2c" && deliveryTarget.type !== "group") {
      log?.error(`File not supported in ${deliveryTarget.type}`);
      return;
    }

    await withTokenRetry(
      creds,
      async () => {
        if (isHttpUrl) {
          await senderSendMedia({
            target: deliveryTarget,
            creds,
            kind: "file",
            source: { url: filePath },
            msgId: target.messageId,
            fileName,
          });
        } else {
          const payloadBuffer = await readPayloadFileBuffer(ctx, filePath, MediaFileType.FILE);
          if (payloadBuffer) {
            await senderSendMedia({
              target: deliveryTarget,
              creds,
              kind: "file",
              source: { buffer: payloadBuffer, fileName },
              msgId: target.messageId,
              fileName,
            });
            return;
          }
          const size = await assertLocalFileWithinTypeLimit(filePath, MediaFileType.FILE);
          log?.debug?.(
            `File local (${formatFileSize(size)}): ${describeMediaTargetForLog(filePath, false)}`,
          );
          await senderSendMedia({
            target: deliveryTarget,
            creds,
            kind: "file",
            source: { localPath: filePath },
            msgId: target.messageId,
            fileName,
            localPathForMeta: filePath,
          });
        }
      },
      log,
      account.accountId,
    );
    log?.debug?.(`File message sent`);
  } catch (err) {
    log?.error(`File send failed: ${formatErrorMessage(err)}`);
  }
}
