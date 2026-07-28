// Feishu plugin module implements dedupe key behavior.
import { createHash } from "node:crypto";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { asNullableRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FeishuMessageEvent } from "./event-types.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { parsePostContent } from "./post.js";

type FeishuMessageDedupeInput = Pick<FeishuMessageEvent, "message" | "sender">;

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

function resolveSenderIdentity(event: FeishuMessageDedupeInput): string | undefined {
  const senderId = event.sender?.sender_id;
  return (
    senderId?.open_id?.trim() ||
    senderId?.union_id?.trim() ||
    senderId?.user_id?.trim() ||
    undefined
  );
}

// Feishu can redeliver the same logical text message with a fresh message_id
// (retry/reconnect), defeating message_id-based dedupe (#46778). For text we key
// on a stable retry identity instead: same sender + chat + create_time + content
// is the same logical message. create_time is the message's own server timestamp
// and stays fixed across redeliveries, so genuine repeat sends (which get a new
// create_time) keep distinct keys and are never suppressed. Falls back to
// message_id when any field is missing so behavior is unchanged then.
function resolveTextRetryDedupeKey(event: FeishuMessageDedupeInput): string | undefined {
  const createTime = event.message.create_time?.trim();
  const chatId = event.message.chat_id?.trim();
  const senderId = resolveSenderIdentity(event);
  if (
    !createTime ||
    parseStrictNonNegativeInteger(createTime) === undefined ||
    !chatId ||
    !senderId
  ) {
    return undefined;
  }
  const contentHash = createHash("sha256")
    .update(event.message.content, "utf8")
    .digest("hex")
    .slice(0, 32);
  return JSON.stringify(["text-retry", senderId, chatId, createTime, contentHash]);
}

export function resolveFeishuMessageDedupeKey(event: FeishuMessageDedupeInput): string | undefined {
  const messageId = event.message.message_id?.trim();
  if (!messageId) {
    return undefined;
  }
  const messageType = event.message.message_type.trim();
  const mediaParts = resolveMessageMediaParts(messageType, event.message.content);
  if (mediaParts.length > 0) {
    return buildMediaDedupeKey(messageId, mediaParts);
  }
  if (messageType === "text") {
    return resolveTextRetryDedupeKey(event) ?? messageId;
  }
  return messageId;
}
