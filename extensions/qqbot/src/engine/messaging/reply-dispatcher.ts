/**
 * Reply dispatcher — structured payload handling and text routing.
 *
 * Uses the unified `sender.ts` business function layer for all message
 * sending. TTS is injected via `ReplyDispatcherDeps`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GatewayAccount } from "../types.js";
import { MAX_UPLOAD_SIZE, formatFileSize } from "../utils/file-utils.js";
import { formatErrorMessage } from "../utils/format.js";
import {
  parseQQBotPayload,
  encodePayloadForCron,
  isCronReminderPayload,
  isMediaPayload,
  type MediaPayload,
} from "../utils/payload.js";
import { normalizePath, resolveQQBotPayloadLocalFilePath } from "../utils/platform.js";
import { normalizeLowercaseStringOrEmpty } from "../utils/string-normalize.js";
import { sanitizeFileName } from "../utils/string-normalize.js";
import {
  sendText as senderSendText,
  sendImage as senderSendImage,
  sendVoiceMessage as senderSendVoice,
  sendVideoMessage as senderSendVideo,
  sendFileMessage as senderSendFile,
  withTokenRetry,
  buildDeliveryTarget,
  accountToCreds,
} from "./sender.js";

// ---- Injected dependencies ----

/** TTS provider interface — injected from the outer layer. */
export interface TTSProvider {
  /** Framework TTS: text → audio file path. */
  textToSpeech(params: { text: string; cfg: unknown; channel: string }): Promise<{
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

export interface MessageTarget {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
}

export interface ReplyContext {
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
export async function sendTextToTarget(
  ctx: ReplyContext,
  text: string,
  refIdx?: string,
): Promise<void> {
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
  return mediaType[0].toUpperCase() + mediaType.slice(1);
}

function validateStructuredPayloadLocalPath(
  ctx: ReplyContext,
  payloadPath: string,
  mediaType: StructuredPayloadMediaType,
): string | null {
  const allowedPath = resolveQQBotPayloadLocalFilePath(payloadPath);
  if (allowedPath) {
    return allowedPath;
  }

  ctx.log?.error(`Blocked ${mediaType} payload local path outside QQ Bot media storage`);
  return null;
}

function isRemoteHttpUrl(p: string): boolean {
  return p.startsWith("http://") || p.startsWith("https://");
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
  return value
    .replace(/[\r\n\t]/g, " ")
    .replaceAll("\0", " ")
    .slice(0, maxLen);
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

async function readStructuredPayloadLocalFile(filePath: string): Promise<Buffer> {
  const openFlags =
    fs.constants.O_RDONLY | ("O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0);
  const handle = await fs.promises.open(filePath, openFlags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Path is not a regular file");
    }
    if (stat.size > MAX_UPLOAD_SIZE) {
      throw new Error(
        `File is too large (${formatFileSize(stat.size)}); QQ Bot API limit is ${formatFileSize(MAX_UPLOAD_SIZE)}`,
      );
    }
    return handle.readFile();
  } finally {
    await handle.close();
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
      const fileBuffer = await readStructuredPayloadLocalFile(imageUrl);
      const base64Data = fileBuffer.toString("base64");
      const ext = normalizeLowercaseStringOrEmpty(path.extname(imageUrl));
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
        log?.error(`Unsupported image format: ${ext}`);
        return;
      }
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
          await senderSendImage(deliveryTarget, imageUrl, creds, {
            msgId: target.messageId,
            localPath: originalImagePath,
          });
        } else if (deliveryTarget.type === "dm") {
          await senderSendText(deliveryTarget, `![](${payload.path})`, creds, {
            msgId: target.messageId,
          });
        } else {
          await senderSendText(deliveryTarget, `![](${payload.path})`, creds, {
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
  const { target, account, cfg, log } = ctx;
  if (!deps) {
    log?.error(`TTS deps not provided, cannot handle audio payload`);
    return;
  }
  try {
    const ttsText = payload.caption || payload.path;
    if (!ttsText?.trim()) {
      log?.error(`Voice missing text`);
      return;
    }

    log?.debug?.(`TTS: "${ttsText.slice(0, 50)}..."`);
    const ttsResult = await deps.tts.textToSpeech({
      text: ttsText,
      cfg,
      channel: "qqbot",
    });
    if (!ttsResult.success || !ttsResult.audioPath) {
      log?.error(`TTS failed: ${ttsResult.error ?? "unknown"}`);
      return;
    }

    const providerLabel = ttsResult.provider ?? "unknown";
    log?.debug?.(
      `TTS returned: provider=${providerLabel}, format=${ttsResult.outputFormat}, path=${ttsResult.audioPath}`,
    );

    const silkBase64 = await deps.tts.audioFileToSilkBase64(ttsResult.audioPath);
    if (!silkBase64) {
      log?.error(`Failed to convert TTS audio to SILK`);
      return;
    }
    const silkPath = ttsResult.audioPath;

    log?.debug?.(`TTS done (${providerLabel}), file: ${silkPath}`);

    const deliveryTarget = buildDeliveryTarget(target);
    const creds = accountToCreds(account);

    await withTokenRetry(
      creds,
      async () => {
        if (deliveryTarget.type === "c2c" || deliveryTarget.type === "group") {
          await senderSendVoice(deliveryTarget, creds, {
            voiceBase64: silkBase64,
            msgId: target.messageId,
            ttsText,
            filePath: silkPath,
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
  } catch (err) {
    log?.error(`TTS/voice send failed: ${formatErrorMessage(err)}`);
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
          await senderSendVideo(deliveryTarget, creds, {
            videoUrl: videoPath,
            msgId: target.messageId,
          });
        } else {
          const fileBuffer = await readStructuredPayloadLocalFile(videoPath);
          const videoBase64 = fileBuffer.toString("base64");
          log?.debug?.(
            `Read local video (${formatFileSize(fileBuffer.length)}): ${describeMediaTargetForLog(videoPath, false)}`,
          );
          await senderSendVideo(deliveryTarget, creds, {
            videoBase64,
            msgId: target.messageId,
            localPath: videoPath,
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
          await senderSendFile(deliveryTarget, creds, {
            fileUrl: filePath,
            msgId: target.messageId,
            fileName,
          });
        } else {
          const fileBuffer = await readStructuredPayloadLocalFile(filePath);
          const fileBase64 = fileBuffer.toString("base64");
          await senderSendFile(deliveryTarget, creds, {
            fileBase64,
            msgId: target.messageId,
            fileName,
            localFilePath: filePath,
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
