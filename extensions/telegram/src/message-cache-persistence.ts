// Lightweight Telegram message-cache persistence contract shared with doctor migrations.
import { createHash } from "node:crypto";
import type { Message } from "grammy/types";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  threadId: string;
};

export type PersistedTelegramMessageCacheValue = {
  version: typeof TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION;
  sourceMessage: Message;
  botUserId?: number;
  promptContextProjection?: TelegramPromptContextProjection | TelegramPromptContextSource;
  threadBinding?: TelegramMessageThreadBinding;
  threadId?: string;
};

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
