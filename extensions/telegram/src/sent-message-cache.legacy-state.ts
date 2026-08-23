// Telegram sent-message cache row shape, keys, and legacy sidecar reader.
//
// Split from `sent-message-cache.ts`, which also value-loads the plugin runtime
// slot and the logger graph. Doctor enumeration cold-loads this module to plan the
// legacy-state import, so it stays a leaf.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";

export const TTL_MS = 24 * 60 * 60 * 1000;
export const TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE = "telegram.sent-messages";
export const TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES = 10_000;

export type PersistedSentMessage = {
  scopeKey: string;
  chatId: string;
  messageId: string;
  timestamp: number;
};

export type SentMessageConfig = Pick<OpenClawConfig, "agents" | "session">;

function resolveSentMessageAgentId(cfg?: SentMessageConfig, agentId?: string): string {
  return agentId?.trim() || (cfg?.agents ? resolveDefaultAgentId(cfg as OpenClawConfig) : "main");
}

function sentMessageScopeKeyForStorePath(storePath: string): string {
  return createHash("sha256").update(storePath, "utf8").digest("hex").slice(0, 24);
}

export function resolveSentMessageScopeKey(cfg?: SentMessageConfig, agentId?: string): string {
  // This 24-hour cache follows the current agent owner. Do not revive a prior owner's
  // transient bucket when the configured default changes.
  return sentMessageScopeKeyForStorePath(
    resolveStorePath(cfg?.session?.store, {
      agentId: resolveSentMessageAgentId(cfg, agentId),
    }),
  );
}

export function sentMessageEntryKey(scopeKey: string, chatId: string, messageId: string): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${chatId}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function resolveSentMessageStorePath(cfg?: SentMessageConfig, agentId?: string): string {
  return `${resolveStorePath(cfg?.session?.store, {
    agentId: resolveSentMessageAgentId(cfg, agentId),
  })}.telegram-sent-messages.json`;
}

// A torn or foreign sidecar yields no entries, exactly as a missing file does; the
// runtime store is authoritative once doctor has migrated.
function readLegacySentMessages(filePath: string): Map<string, Map<string, number>> {
  const store = new Map<string, Map<string, number>>();
  let parsed: Record<string, Record<string, number>>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
      string,
      Record<string, number>
    >;
  } catch {
    return store;
  }
  const now = Date.now();
  for (const [chatId, entry] of Object.entries(parsed)) {
    const messages = new Map<string, number>();
    for (const [messageId, timestamp] of Object.entries(entry)) {
      if (typeof timestamp === "number" && Number.isFinite(timestamp) && now - timestamp < TTL_MS) {
        messages.set(messageId, timestamp);
      }
    }
    if (messages.size > 0) {
      store.set(chatId, messages);
    }
  }
  return store;
}

export function listTelegramLegacySentMessageCacheEntries(params: {
  cfg?: SentMessageConfig;
  agentId?: string;
  persistedPath?: string;
  targetStorePath?: string;
}): Array<{ key: string; value: PersistedSentMessage; ttlMs?: number; timestamp?: number }> {
  const scopeKey = params.targetStorePath
    ? sentMessageScopeKeyForStorePath(params.targetStorePath)
    : resolveSentMessageScopeKey(params.cfg, params.agentId);
  const filePath = params.persistedPath ?? resolveSentMessageStorePath(params.cfg, params.agentId);
  const legacy = fs.existsSync(filePath)
    ? readLegacySentMessages(filePath)
    : new Map<string, Map<string, number>>();
  return [...legacy.entries()].flatMap(([chatId, messages]) =>
    [...messages.entries()].flatMap(([messageId, timestamp]) => {
      const ttlMs = TTL_MS - Math.max(0, Date.now() - timestamp);
      return ttlMs > 0
        ? [
            {
              key: sentMessageEntryKey(scopeKey, chatId, messageId),
              value: { scopeKey, chatId, messageId, timestamp },
              ttlMs,
              timestamp,
            },
          ]
        : [];
    }),
  );
}
