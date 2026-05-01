import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { createBlueBubblesClientFromParts } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type BlueBubblesHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

type BlueBubblesHistoryFetchResult = {
  entries: BlueBubblesHistoryEntry[];
  /**
   * True when at least one API path returned a recognized response shape.
   * False means all attempts failed or returned unusable data.
   */
  resolved: boolean;
};

type BlueBubblesMessageData = {
  guid?: string;
  text?: string;
  handle_id?: string;
  is_from_me?: boolean;
  date_created?: number;
  date_delivered?: number;
  associated_message_guid?: string;
  sender?: {
    address?: string;
    display_name?: string;
  };
};

type BlueBubblesChatOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
};

function resolveAccount(params: BlueBubblesChatOpts) {
  return resolveBlueBubblesServerAccount(params);
}

const MAX_HISTORY_FETCH_LIMIT = 100;
const HISTORY_SCAN_MULTIPLIER = 8;
const MAX_HISTORY_SCAN_MESSAGES = 500;
const MAX_HISTORY_BODY_CHARS = 2_000;

function clampHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return 0;
  }
  return Math.min(normalized, MAX_HISTORY_FETCH_LIMIT);
}

function truncateHistoryBody(text: string): string {
  if (text.length <= MAX_HISTORY_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_HISTORY_BODY_CHARS).trimEnd()}...`;
}

/**
 * Fetch message history from BlueBubbles API for a specific chat.
 * This provides the initial backfill for both group chats and DMs.
 */
export async function fetchBlueBubblesHistory(
  chatIdentifier: string,
  limit: number,
  opts: BlueBubblesChatOpts = {},
): Promise<BlueBubblesHistoryFetchResult> {
  const effectiveLimit = clampHistoryLimit(limit);
  if (!chatIdentifier.trim() || effectiveLimit <= 0) {
    return { entries: [], resolved: true };
  }

  let baseUrl: string;
  let password: string;
  let allowPrivateNetwork = false;
  try {
    ({ baseUrl, password, allowPrivateNetwork } = resolveAccount(opts));
  } catch {
    return { entries: [], resolved: false };
  }
  const client = createBlueBubblesClientFromParts({
    baseUrl,
    password,
    allowPrivateNetwork,
    timeoutMs: opts.timeoutMs ?? 10000,
  });

  // Try different common API patterns for fetching messages
  const possiblePaths = [
    `/api/v1/chat/${encodeURIComponent(chatIdentifier)}/messages?limit=${effectiveLimit}&sort=DESC`,
    `/api/v1/messages?chatGuid=${encodeURIComponent(chatIdentifier)}&limit=${effectiveLimit}`,
    `/api/v1/chat/${encodeURIComponent(chatIdentifier)}/message?limit=${effectiveLimit}`,
  ];

  for (const path of possiblePaths) {
    try {
      const res = await client.request({
        method: "GET",
        path,
        timeoutMs: opts.timeoutMs ?? 10000,
      });

      if (!res.ok) {
        continue; // Try next path
      }

      const data = await res.json().catch(() => null);
      if (!data) {
        continue;
      }

      // Handle different response structures
      let messages: unknown[] = [];
      if (Array.isArray(data)) {
        messages = data;
      } else if (data.data && Array.isArray(data.data)) {
        messages = data.data;
      } else if (data.messages && Array.isArray(data.messages)) {
        messages = data.messages;
      } else {
        continue;
      }

      const historyEntries: BlueBubblesHistoryEntry[] = [];

      const maxScannedMessages = Math.min(
        Math.max(effectiveLimit * HISTORY_SCAN_MULTIPLIER, effectiveLimit),
        MAX_HISTORY_SCAN_MESSAGES,
      );
      for (let i = 0; i < messages.length && i < maxScannedMessages; i++) {
        const item = messages[i];
        const msg = item as BlueBubblesMessageData;

        // Skip messages without text content
        const text = msg.text?.trim();
        if (!text) {
          continue;
        }

        const sender = msg.is_from_me
          ? "me"
          : msg.sender?.display_name || msg.sender?.address || msg.handle_id || "Unknown";
        const timestamp = msg.date_created || msg.date_delivered;

        historyEntries.push({
          sender,
          body: truncateHistoryBody(text),
          timestamp,
          messageId: msg.guid,
        });
      }

      // Sort by timestamp (oldest first for context)
      historyEntries.sort((a, b) => {
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        return aTime - bTime;
      });

      return {
        entries: historyEntries.slice(0, effectiveLimit), // Ensure we don't exceed the requested limit
        resolved: true,
      };
    } catch {
      // Continue to next path
      continue;
    }
  }

  // If none of the API paths worked, return empty history
  return { entries: [], resolved: false };
}
