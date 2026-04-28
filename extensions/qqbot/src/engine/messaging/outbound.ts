/**
 * Outbound messaging — aggregates reply limits, audio port, media sends, and text orchestration.
 */

export { setOutboundAudioPort } from "./outbound-audio-port.js";
export type {
  OutboundContext,
  MediaOutboundContext,
  OutboundResult,
  OutboundErrorCode,
  MediaTargetContext,
} from "./outbound-types.js";
export { OUTBOUND_ERROR_CODES, DEFAULT_MEDIA_SEND_ERROR } from "./outbound-types.js";

export {
  checkMessageReplyLimit,
  recordMessageReply,
  getMessageReplyStats,
  getMessageReplyConfig,
  MESSAGE_REPLY_LIMIT,
} from "./outbound-reply.js";
export type { ReplyLimitResult } from "./outbound-reply.js";

export { resolveUserFacingMediaError } from "./outbound-result-helpers.js";

export {
  buildMediaTarget,
  parseTarget,
  resolveOutboundMediaPath,
  sendDocument,
  sendPhoto,
  sendVideoMsg,
  sendVoice,
} from "./outbound-media-send.js";

import type { GatewayAccount } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugError, debugLog, debugWarn } from "../utils/log.js";
import { normalizeMediaTags } from "../utils/media-tags.js";
import { decodeCronPayload } from "../utils/payload.js";
import { normalizePath } from "../utils/platform.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../utils/string-normalize.js";
import {
  isImageFile as coreIsImageFile,
  isVideoFile as coreIsVideoFile,
} from "./media-type-detect.js";
import { isAudioFile } from "./outbound-audio-port.js";
import {
  buildMediaTarget,
  parseTarget,
  resolveOutboundMediaPath,
  sendDocument,
  sendPhoto,
  sendVideoMsg,
  sendVoice,
} from "./outbound-media-send.js";
import {
  checkMessageReplyLimit,
  MESSAGE_REPLY_LIMIT,
  recordMessageReply,
} from "./outbound-reply.js";
import type {
  MediaOutboundContext,
  MediaTargetContext,
  OutboundContext,
  OutboundResult,
} from "./outbound-types.js";
import {
  initApiConfig,
  accountToCreds,
  sendText as senderSendText,
  type DeliveryTarget,
} from "./sender.js";

const isImageFile = coreIsImageFile;
const isVideoFile = coreIsVideoFile;

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

      mediaPath = mediaPath.replace(/\\\\/g, "\\");

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

  const result = await sendPhoto(target, mediaUrl);
  if (!result.error && text?.trim()) {
    await sendTextAfterMedia(target, text);
  }
  return result;
}

async function sendTextAfterMedia(ctx: MediaTargetContext, text: string): Promise<void> {
  try {
    const creds = accountToCreds(ctx.account);
    const target: DeliveryTarget = { type: ctx.targetType, id: ctx.targetId };
    await senderSendText(target, text, creds, { msgId: ctx.replyToId });
  } catch (err) {
    debugError(`[qqbot] sendTextAfterMedia failed: ${formatErrorMessage(err)}`);
  }
}

export async function sendProactiveMessage(
  account: GatewayAccount,
  to: string,
  content: string,
): Promise<OutboundResult> {
  return sendText({ account, to, text: content });
}

export async function sendCronMessage(
  account: GatewayAccount,
  to: string,
  message: string,
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  debugLog(`[${timestamp}] [qqbot] sendCronMessage: to=${to}, message length=${message.length}`);

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

      const targetTo =
        payload.targetType === "group" ? `group:${payload.targetAddress}` : payload.targetAddress;

      debugLog(
        `[${timestamp}] [qqbot] sendCronMessage: sending proactive message to targetTo=${targetTo}`,
      );

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

  debugLog(`[${timestamp}] [qqbot] sendCronMessage: plain text message, sending to ${to}`);
  return await sendText({ account, to, text: message });
}
