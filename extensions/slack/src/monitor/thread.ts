// Slack plugin module implements thread behavior.
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackFileReferenceList } from "../file-reference.js";
import type { SlackAttachment, SlackFile } from "../types.js";
import { chooseSlackPrimaryText, resolveSlackBlocksText } from "./block-text.js";
import { logVerbose } from "./thread.runtime.js";

export type SlackThreadStarter = {
  text: string;
  userId?: string;
  botId?: string;
  ts?: string;
  files?: SlackFile[];
};

type SlackThreadStarterCacheEntry = {
  value: SlackThreadStarter;
  expiresAt: number;
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarterCacheEntry>();
const THREAD_STARTER_CACHE_TTL_MS = 6 * 60 * 60_000;
const THREAD_STARTER_CACHE_MAX = 2000;

function evictThreadStarterCache(): void {
  const now = asDateTimestampMs(Date.now());
  if (now === undefined) {
    THREAD_STARTER_CACHE.clear();
    return;
  }
  for (const [cacheKey, entry] of THREAD_STARTER_CACHE.entries()) {
    if (asDateTimestampMs(entry.expiresAt) === undefined || entry.expiresAt <= now) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
  }
  pruneMapToMaxSize(THREAD_STARTER_CACHE, THREAD_STARTER_CACHE_MAX);
}

function formatSlackFilePlaceholder(files: SlackFile[] | undefined): string {
  return `[attached: ${formatSlackFileReferenceList(files)}]`;
}

function pushUniqueText(parts: string[], value: string | undefined): void {
  const text = normalizeOptionalString(value);
  if (text && !parts.includes(text)) {
    parts.push(text);
  }
}

function resolveSlackBlocksFallbackText(blocks: unknown[] | undefined): string | undefined {
  return resolveSlackBlocksText(blocks)?.text;
}

function resolveSlackAttachmentFallbackText(
  attachments: SlackAttachment[] | undefined,
): string | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const attachment of attachments) {
    pushUniqueText(parts, attachment.pretext);
    pushUniqueText(parts, attachment.title);
    pushUniqueText(parts, attachment.text);
    pushUniqueText(parts, attachment.fallback);
    for (const field of attachment.fields ?? []) {
      pushUniqueText(parts, field.title);
      pushUniqueText(parts, field.value);
    }
    pushUniqueText(parts, resolveSlackBlocksFallbackText(attachment.blocks));
    pushUniqueText(parts, resolveSlackBlocksFallbackText(attachment.message_blocks));
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function resolveSlackMessageText(message: {
  text?: string;
  blocks?: unknown[];
  attachments?: SlackAttachment[];
}): string | undefined {
  const messageText =
    normalizeOptionalString(message.text) ??
    resolveSlackAttachmentFallbackText(message.attachments);
  return chooseSlackPrimaryText({
    messageText,
    blocksText: resolveSlackBlocksText(message.blocks),
  });
}

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  /** Enterprise cache partition. Omit to preserve workspace-install cache identity. */
  workspaceScope?: { accountId: string; teamId: string };
}): Promise<SlackThreadStarter | null> {
  evictThreadStarterCache();
  const cacheKey = params.workspaceScope
    ? JSON.stringify([
        params.workspaceScope.accountId,
        params.workspaceScope.teamId,
        params.channelId,
        params.threadTs,
      ])
    : `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached) {
    const now = asDateTimestampMs(Date.now());
    if (now !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    THREAD_STARTER_CACHE.delete(cacheKey);
  }
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as {
      messages?: Array<{
        text?: string;
        user?: string;
        bot_id?: string;
        ts?: string;
        files?: SlackFile[];
        blocks?: unknown[];
        attachments?: SlackAttachment[];
      }>;
    };
    const message = response?.messages?.[0];
    const text = message ? resolveSlackMessageText(message) : undefined;
    const files = message?.files?.length ? message.files : undefined;
    if (!message || (!text && !files)) {
      return null;
    }
    const starter: SlackThreadStarter = {
      text: text || formatSlackFilePlaceholder(files),
      userId: message.user,
      botId: message.bot_id,
      ts: message.ts,
      files,
    };
    const expiresAt = resolveExpiresAtMsFromDurationMs(THREAD_STARTER_CACHE_TTL_MS);
    if (expiresAt !== undefined) {
      if (THREAD_STARTER_CACHE.has(cacheKey)) {
        THREAD_STARTER_CACHE.delete(cacheKey);
      }
      THREAD_STARTER_CACHE.set(cacheKey, {
        value: starter,
        expiresAt,
      });
      evictThreadStarterCache();
    }
    return starter;
  } catch (err) {
    logVerbose(
      `slack thread starter fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    return null;
  }
}

export function resetSlackThreadStarterCacheForTest(): void {
  THREAD_STARTER_CACHE.clear();
}

type SlackThreadMessage = {
  text: string;
  userId?: string;
  ts?: string;
  botId?: string;
  files?: SlackFile[];
};

type SlackRepliesPageMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  files?: SlackFile[];
  blocks?: unknown[];
  attachments?: SlackAttachment[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

const SLACK_THREAD_HISTORY_MAX_PAGES = 3;

/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination and keeps only the latest N retained messages when the full
 * thread fits in the bounded fetch window.
 */
export async function resolveSlackThreadHistory(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  currentMessageTs?: string;
  limit?: number;
}): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  // Slack recommends no more than 200 per page.
  const fetchLimit = 200;
  const retained: SlackRepliesPageMessage[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;

  try {
    do {
      pagesFetched += 1;
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;

      for (const msg of response.messages ?? []) {
        const text = resolveSlackMessageText(msg);
        // Keep messages with text, Slack attachment/block fallback text, or file attachments.
        if (!text && !msg.files?.length) {
          continue;
        }
        if (params.currentMessageTs && msg.ts === params.currentMessageTs) {
          continue;
        }
        retained.push(msg);
      }
      if (retained.length > maxMessages) {
        retained.splice(0, retained.length - maxMessages);
      }

      const next = response.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
      // Slack replies paginate oldest to newest with no reverse cursor; cap cold
      // thread seeding so pathological long threads cannot block dispatch.
    } while (cursor && pagesFetched < SLACK_THREAD_HISTORY_MAX_PAGES);

    if (cursor) {
      logVerbose(
        `slack thread history capped channel=${params.channelId} ts=${params.threadTs} pages=${SLACK_THREAD_HISTORY_MAX_PAGES}`,
      );
      return [];
    }

    return retained.map((msg) => ({
      // For file-only messages, create a placeholder showing attached filenames.
      text: resolveSlackMessageText(msg) ?? formatSlackFilePlaceholder(msg.files),
      userId: msg.user,
      botId: msg.bot_id,
      ts: msg.ts,
      files: msg.files,
    }));
  } catch (err) {
    logVerbose(
      `slack thread history fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    return [];
  }
}
