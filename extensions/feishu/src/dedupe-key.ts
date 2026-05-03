import type { FeishuMessageEvent } from "./event-types.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { parsePostContent } from "./post.js";

type FeishuMessageDedupeInput = Pick<FeishuMessageEvent, "message">;

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readExternalKey(value: unknown): string | undefined {
  return normalizeFeishuExternalKey(typeof value === "string" ? value : "");
}

function parseContentRecord(content: string): Record<string, unknown> | null {
  try {
    return readRecord(JSON.parse(content));
  } catch {
    return null;
  }
}

function buildMediaDedupeKey(messageId: string, mediaParts: string[]): string {
  return JSON.stringify([messageId, ...mediaParts]);
}

function resolvePostMediaParts(content: string): string[] {
  const parsed = parsePostContent(content);
  return [
    ...parsed.imageKeys.map((imageKey) => `image_key:${imageKey}`),
    ...parsed.mediaKeys.map((media) => `file_key:${media.fileKey}`),
  ];
}

function resolveMessageMediaParts(messageType: string, content: string): string[] {
  if (messageType === "post") {
    return resolvePostMediaParts(content);
  }

  const parsed = parseContentRecord(content);
  if (!parsed) {
    return [];
  }

  const imageKey = readExternalKey(parsed.image_key);
  const fileKey = readExternalKey(parsed.file_key);
  switch (messageType) {
    case "image":
      return imageKey ? [`image_key:${imageKey}`] : [];
    case "file":
    case "audio":
    case "sticker":
      return fileKey ? [`file_key:${fileKey}`] : [];
    case "video":
    case "media":
      return fileKey ? [`file_key:${fileKey}`] : imageKey ? [`image_key:${imageKey}`] : [];
    default:
      return fileKey ? [`file_key:${fileKey}`] : imageKey ? [`image_key:${imageKey}`] : [];
  }
}

export function resolveFeishuMessageDedupeKey(event: FeishuMessageDedupeInput): string | undefined {
  const messageId = event.message.message_id?.trim();
  if (!messageId) {
    return undefined;
  }
  const messageType = event.message.message_type.trim();
  const mediaParts = resolveMessageMediaParts(messageType, event.message.content);
  return mediaParts.length > 0 ? buildMediaDedupeKey(messageId, mediaParts) : messageId;
}
