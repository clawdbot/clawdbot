// Feishu plugin module parses media keys and stubs from raw message bodies.
// Keep this module dependency-light (post parsing + types only): send.ts and
// bot-content.ts both import it, and heavier imports here re-create the
// media.ts -> send.ts import cycle.
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { parsePostContent } from "./post.js";
import type { FeishuMessageMediaKeys } from "./types.js";

export function parseFeishuMediaKeys(
  content: string,
  messageType: string,
): { imageKey?: string; fileKey?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    switch (messageType) {
      case "image":
        return { imageKey, fileName: parsed.file_name };
      case "file":
      case "audio":
      case "sticker":
        return { fileKey, fileName: parsed.file_name };
      case "video":
      case "media":
        return { fileKey, imageKey, fileName: parsed.file_name };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

const FEISHU_MEDIA_MSG_TYPES = new Set(["image", "file", "audio", "video", "media", "sticker"]);

export function isFeishuMediaMessageType(msgType: string): boolean {
  return FEISHU_MEDIA_MSG_TYPES.has(msgType);
}

/**
 * Text stub for a referenced media message. History/quoted media render as a
 * stub; the actual file_key/image_key is surfaced via
 * FeishuMessageInfo.mediaKeys so callers can download the bytes when needed.
 */
export function formatFeishuMediaMessageStub(parsed: unknown, msgType: string): string {
  const body = (parsed ?? {}) as { speech_to_text?: unknown; file_name?: unknown };
  if (msgType === "audio" && typeof body.speech_to_text === "string") {
    const speechToText = body.speech_to_text.trim();
    if (speechToText) {
      return speechToText;
    }
  }
  const fileName = typeof body.file_name === "string" ? body.file_name.trim() : "";
  const stub = `[${msgType} message]`;
  return fileName ? `${stub} (${fileName})` : stub;
}

/**
 * Extract raw image_key/file_key references from a message body so callers can
 * later download the attachment the referenced message carries.
 */
export function extractFeishuMessageMediaKeys(
  rawContent: string,
  msgType: string,
): FeishuMessageMediaKeys | undefined {
  if (!rawContent) {
    return undefined;
  }
  if (msgType === "post") {
    const { imageKeys, mediaKeys } = parsePostContent(rawContent);
    if (imageKeys.length === 0 && mediaKeys.length === 0) {
      return undefined;
    }
    return {
      ...(imageKeys.length > 0 ? { imageKeys } : {}),
      ...(mediaKeys.length > 0 ? { mediaKeys } : {}),
    };
  }
  if (!FEISHU_MEDIA_MSG_TYPES.has(msgType)) {
    return undefined;
  }
  const keys = parseFeishuMediaKeys(rawContent, msgType);
  if (!keys.imageKey && !keys.fileKey) {
    return undefined;
  }
  return keys;
}
