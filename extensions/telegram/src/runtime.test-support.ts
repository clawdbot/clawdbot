// Telegram test support owns cleanup for process-global plugin state.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { TelegramRuntime } from "./runtime.types.js";

const TELEGRAM_ACCOUNT_THROTTLERS_KEY = Symbol.for("openclaw.telegram.accountThrottlers");
const TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY = Symbol.for("openclaw.telegram.messageCacheBuckets");
const TELEGRAM_POLLING_LEASES_KEY = Symbol.for("openclaw.telegram.pollingLeases");
const TELEGRAM_POLLING_SESSION_STATE_KEY = Symbol.for("openclaw.telegram.pollingSessionState");
const TELEGRAM_REPLY_FENCE_STATE_KEY = Symbol.for("openclaw.telegram.replyFenceState");
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");
const TELEGRAM_TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");

const { clearRuntime } = createPluginRuntimeStore<TelegramRuntime>({
  pluginId: "telegram",
  errorMessage: "Telegram runtime not initialized",
});

function clearMapState(key: symbol): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const value = globalRecord[key];
  if (value instanceof Map) {
    value.clear();
  }
}

export function clearTelegramRuntimeForTest(): void {
  clearRuntime();
}

export function resetTelegramAccountThrottlersForTest(): void {
  clearMapState(TELEGRAM_ACCOUNT_THROTTLERS_KEY);
}

export function resetTelegramMessageCacheForTest(): void {
  clearMapState(TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY);
}

export function resetTelegramPollingLeasesForTest(): void {
  const proc = process as NodeJS.Process & {
    [TELEGRAM_POLLING_LEASES_KEY]?: Map<unknown, unknown>;
  };
  proc[TELEGRAM_POLLING_LEASES_KEY]?.clear();
}

export function resetTelegramPollingSessionStateForTest(): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const state = globalRecord[TELEGRAM_POLLING_SESSION_STATE_KEY] as
    | { activeHandlersByLane?: Map<unknown, unknown>; drainHealthBySpool?: Map<unknown, unknown> }
    | undefined;
  state?.activeHandlersByLane?.clear();
  state?.drainHealthBySpool?.clear();
}

export function resetTelegramReplyFenceForTest(): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const state = globalRecord[TELEGRAM_REPLY_FENCE_STATE_KEY] as
    | { byKey?: Map<unknown, unknown>; keysByLane?: Map<unknown, unknown> }
    | undefined;
  state?.byKey?.clear();
  state?.keysByLane?.clear();
}

export function resetTelegramSentMessageCacheForTest(): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  delete globalRecord[TELEGRAM_SENT_MESSAGES_STATE_KEY];
}

export function resetTelegramTopicNameCacheForTest(): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  delete globalRecord[TELEGRAM_TOPIC_NAME_CACHE_STATE_KEY];
}
