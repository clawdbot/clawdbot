// Lightweight Telegram message-cache persistence contract shared with doctor migrations.
import { createHash } from "node:crypto";
import type { Message } from "grammy/types";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TelegramMediaKind } from "./bot/body-helpers.js";
import type { StickerMetadata } from "./bot/types.js";
import type {
  TelegramPromptContextProjection,
  TelegramPromptContextSource,
} from "./prompt-context-projection.js";

export const TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES = 3000;
export const TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE = "telegram.message-cache";
// Versioned writes preserve projection provenance. Shipped unversioned rows
// hydrate as markerless context only; they never imply transcript projection.
export const TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION = 1;

export type TelegramMessageThreadBinding = {
  kind: "provider-observed-v1";
  threadSpec:
    | { scope: "direct-messages"; id: number }
    | { scope: "dm"; id: number }
    | { scope: "forum"; id: number };
};

export type TelegramResolvedMedia = {
  id: string;
  fileUniqueId: string;
  size: number;
  savedAt: number;
  kind: TelegramMediaKind;
  contentType?: string;
  stickerMetadata?: StickerMetadata;
};

export type PersistedTelegramMessageCacheValue = {
  version: typeof TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION;
  sourceMessage: Message;
  botUserId?: number;
  promptContextProjection?: TelegramPromptContextProjection | TelegramPromptContextSource;
  resolvedMedia?: TelegramResolvedMedia;
  threadBinding?: TelegramMessageThreadBinding;
  threadId?: string;
};

const TELEGRAM_MEDIA_KINDS = new Set<string>(["audio", "document", "image", "sticker", "video"]);

function isTelegramMediaKind(value: unknown): value is TelegramMediaKind {
  return typeof value === "string" && TELEGRAM_MEDIA_KINDS.has(value);
}

function parseStickerMetadata(value: unknown): StickerMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    ...(typeof value.emoji === "string" ? { emoji: value.emoji } : {}),
    ...(typeof value.setName === "string" ? { setName: value.setName } : {}),
    ...(typeof value.fileId === "string" ? { fileId: value.fileId } : {}),
    ...(typeof value.fileUniqueId === "string" ? { fileUniqueId: value.fileUniqueId } : {}),
    ...(typeof value.cachedDescription === "string"
      ? { cachedDescription: value.cachedDescription }
      : {}),
  };
}

export function parseTelegramResolvedMedia(value: unknown): TelegramResolvedMedia | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.includes("/") ||
    value.id.includes("\\") ||
    value.id.includes("\0") ||
    typeof value.fileUniqueId !== "string" ||
    !value.fileUniqueId ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.savedAt !== "number" ||
    !Number.isFinite(value.savedAt) ||
    !isTelegramMediaKind(value.kind)
  ) {
    return undefined;
  }
  const stickerMetadata = parseStickerMetadata(value.stickerMetadata);
  return {
    id: value.id,
    fileUniqueId: value.fileUniqueId,
    size: value.size,
    savedAt: value.savedAt,
    kind: value.kind,
    ...(typeof value.contentType === "string" ? { contentType: value.contentType } : {}),
    ...(stickerMetadata ? { stickerMetadata } : {}),
  };
}

export function resolveTelegramMessageCachePath(storePath: string): string {
  return `${storePath}.telegram-messages.json`;
}

export function resolveTelegramMessageCacheScope(storePath: string): string {
  return resolveTelegramMessageCachePath(storePath);
}

export function resolveTelegramMessageCachePersistentScopeKey(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 24);
}

export function isTelegramMessageCacheSourceMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.message_id === "number" &&
    Number.isFinite(value.message_id) &&
    typeof value.date === "number" &&
    Number.isFinite(value.date)
  );
}
