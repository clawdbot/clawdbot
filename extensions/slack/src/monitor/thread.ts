import type { WebClient as SlackWebClient } from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatSlackFileReferenceList } from "../file-reference.js";
import type { SlackFile } from "../types.js";
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
  cachedAt: number;
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarterCacheEntry>();
const THREAD_STARTER_CACHE_TTL_MS = 6 * 60 * 60_000;
const THREAD_STARTER_CACHE_MAX = 2000;

function evictThreadStarterCache(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of THREAD_STARTER_CACHE.entries()) {
    if (now - entry.cachedAt > THREAD_STARTER_CACHE_TTL_MS) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
  }
  pruneMapToMaxSize(THREAD_STARTER_CACHE, THREAD_STARTER_CACHE_MAX);
}

function formatSlackFilePlaceholder(files: SlackFile[] | undefined): string {
  return `[attached: ${formatSlackFileReferenceList(files)}]`;
}

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
}): Promise<SlackThreadStarter | null> {
  evictThreadStarterCache();
  const cacheKey = `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= THREAD_STARTER_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached) {
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
      }>;
    };
    const message = response?.messages?.[0];
    const text = (message?.text ?? "").trim();
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
    if (THREAD_STARTER_CACHE.has(cacheKey)) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
    THREAD_STARTER_CACHE.set(cacheKey, {
      value: starter,
      cachedAt: Date.now(),
    });
    evictThreadStarterCache();
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

export type SlackThreadMessage = {
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
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination and keeps only the latest N retained messages so long threads
 * still produce up-to-date context without unbounded memory growth.
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

  try {
    do {
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;

      for (const msg of response.messages ?? []) {
        // Keep messages with text OR file attachments.
        if (!msg.text?.trim() && !msg.files?.length) {
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
    } while (cursor);

    return retained.map((msg) => ({
      // For file-only messages, create a placeholder showing attached filenames.
      text: msg.text?.trim() ? msg.text : formatSlackFilePlaceholder(msg.files),
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
