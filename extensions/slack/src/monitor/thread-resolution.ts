// Slack plugin module implements thread resolution behavior.
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  asDateTimestampMs,
  parseFiniteNumber,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../errors.js";
import type { SlackMessageEvent } from "../types.js";

type ThreadTsCacheEntry = {
  threadTs: string | null;
  expiresAt: number;
};

const DEFAULT_THREAD_TS_CACHE_TTL_MS = 60_000;
const DEFAULT_THREAD_TS_CACHE_MAX = 500;

const normalizeThreadTs = (threadTs?: string | null) => {
  const trimmed = threadTs?.trim();
  return trimmed ? trimmed : undefined;
};

const markAmbiguousThreadReply = (message: SlackMessageEvent): SlackMessageEvent => ({
  ...message,
  _ambiguousThreadReply: true,
});

async function resolveThreadTsFromHistory(params: {
  client: SlackWebClient;
  channelId: string;
  messageTs: string;
}) {
  try {
    const response = (await params.client.conversations.history({
      channel: params.channelId,
      latest: params.messageTs,
      oldest: params.messageTs,
      inclusive: true,
      limit: 1,
    })) as { messages?: Array<{ ts?: string; thread_ts?: string }> };
    const message =
      response.messages?.find((entry) => entry.ts === params.messageTs) ?? response.messages?.[0];
    return normalizeThreadTs(message?.thread_ts);
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(
        `slack inbound: failed to resolve thread_ts via conversations.history for channel=${params.channelId} ts=${params.messageTs}: ${formatSlackError(err)}`,
      );
    }
    return undefined;
  }
}

export function createSlackThreadTsResolver(params: {
  client: SlackWebClient;
  cacheTtlMs?: number;
  maxSize?: number;
}) {
  const ttlMs = Math.max(0, parseFiniteNumber(params.cacheTtlMs) ?? DEFAULT_THREAD_TS_CACHE_TTL_MS);
  const maxSize = Math.max(0, parseFiniteNumber(params.maxSize) ?? DEFAULT_THREAD_TS_CACHE_MAX);
  const cache = new Map<string, ThreadTsCacheEntry>();
  const inflight = new Map<string, Promise<string | undefined>>();

  const getCached = (key: string, now: number) => {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt === 0) {
      cache.delete(key);
      cache.set(key, entry);
      return entry.threadTs;
    }
    const normalizedNow = asDateTimestampMs(now);
    if (
      normalizedNow === undefined ||
      asDateTimestampMs(entry.expiresAt) === undefined ||
      entry.expiresAt <= normalizedNow
    ) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.threadTs;
  };

  const setCached = (key: string, threadTs: string | null, now: number) => {
    const expiresAt = ttlMs > 0 ? resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: now }) : 0;
    if (expiresAt === undefined) {
      cache.delete(key);
      return;
    }
    cache.delete(key);
    cache.set(key, { threadTs, expiresAt });
    pruneMapToMaxSize(cache, maxSize);
  };

  return {
    resolve: async (request: {
      message: SlackMessageEvent;
      source: "message" | "app_mention";
    }): Promise<SlackMessageEvent> => {
      const { message } = request;
      if (!message.parent_user_id || message.thread_ts || !message.ts) {
        return message;
      }

      const cacheKey = `${message.channel}:${message.ts}`;
      const now = Date.now();
      const cached = getCached(cacheKey, now);
      if (cached !== undefined) {
        return cached ? { ...message, thread_ts: cached } : markAmbiguousThreadReply(message);
      }

      if (shouldLogVerbose()) {
        logVerbose(
          `slack inbound: missing thread_ts for thread reply channel=${message.channel} ts=${message.ts} source=${request.source}`,
        );
      }

      let pending = inflight.get(cacheKey);
      if (!pending) {
        pending = resolveThreadTsFromHistory({
          client: params.client,
          channelId: message.channel,
          messageTs: message.ts,
        });
        inflight.set(cacheKey, pending);
      }

      let resolved: string | undefined;
      try {
        resolved = await pending;
      } finally {
        inflight.delete(cacheKey);
      }

      setCached(cacheKey, resolved ?? null, Date.now());

      if (resolved) {
        if (shouldLogVerbose()) {
          logVerbose(
            `slack inbound: resolved missing thread_ts channel=${message.channel} ts=${message.ts} -> thread_ts=${resolved}`,
          );
        }
        return { ...message, thread_ts: resolved };
      }

      if (shouldLogVerbose()) {
        logVerbose(
          `slack inbound: could not resolve missing thread_ts channel=${message.channel} ts=${message.ts}; marking reply ambiguous`,
        );
      }
      return markAmbiguousThreadReply(message);
    },
  };
}
