import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { asRecord, extractMessageText, formatErrorMessage } from "./utils.js";

/**
 * Format a number as @ud (with dots every 3 digits from the right)
 * e.g., 170141184507799509469114119040828178432 -> 170.141.184.507.799.509.469.114.119.040.828.178.432
 */
function formatUd(id: string | number): string {
  const str = String(id).replace(/\./g, ""); // Remove any existing dots
  const reversed = str.split("").toReversed();
  const chunks: string[] = [];
  for (let i = 0; i < reversed.length; i += 3) {
    chunks.push(
      reversed
        .slice(i, i + 3)
        .toReversed()
        .join(""),
    );
  }
  return chunks.toReversed().join(".");
}

export type TlonHistoryEntry = {
  author: string;
  content: string;
  timestamp: number;
  id?: string;
};

function createHistoryEntryFromMemo(params: {
  memo?: Record<string, unknown> | null;
  seal?: Record<string, unknown> | null;
  fallbackId?: unknown;
}): TlonHistoryEntry {
  const { memo, seal, fallbackId } = params;
  return {
    author: typeof memo?.author === "string" ? memo.author : "unknown",
    content: extractMessageText(memo?.content || []),
    timestamp: typeof memo?.sent === "number" ? memo.sent : Date.now(),
    id:
      typeof seal?.id === "string"
        ? seal.id
        : typeof fallbackId === "string"
          ? fallbackId
          : undefined,
  };
}

const messageCache = new Map<string, TlonHistoryEntry[]>();
const MAX_CACHED_MESSAGES = 100;

export function cacheMessage(channelNest: string, message: TlonHistoryEntry) {
  if (!messageCache.has(channelNest)) {
    messageCache.set(channelNest, []);
  }
  const cache = messageCache.get(channelNest);
  if (!cache) {
    return;
  }
  cache.unshift(message);
  if (cache.length > MAX_CACHED_MESSAGES) {
    cache.pop();
  }
}

export async function fetchChannelHistory(
  api: { scry: (path: string) => Promise<unknown> },
  channelNest: string,
  count = 50,
  runtime?: RuntimeEnv,
): Promise<TlonHistoryEntry[]> {
  try {
    const scryPath = `/channels/v4/${channelNest}/posts/newest/${count}/outline.json`;
    runtime?.log?.(`[tlon] Fetching history: ${scryPath}`);

    const data: unknown = await api.scry(scryPath);
    if (!data) {
      return [];
    }

    let posts: unknown[] = [];
    if (Array.isArray(data)) {
      posts = data;
    } else {
      const dataRecord = asRecord(data);
      const postMap = asRecord(dataRecord?.posts);
      if (postMap) {
        posts = Object.values(postMap);
      } else if (dataRecord) {
        posts = Object.values(dataRecord);
      }
    }

    const messages = posts
      .map((item) => {
        const itemRecord = asRecord(item);
        const replyPost = asRecord(itemRecord?.["r-post"]);
        const replyPostSet = asRecord(replyPost?.set);
        const essay = asRecord(itemRecord?.essay) ?? asRecord(replyPostSet?.essay);
        const seal = asRecord(itemRecord?.seal) ?? asRecord(replyPostSet?.seal);

        return {
          author: typeof essay?.author === "string" ? essay.author : "unknown",
          content: extractMessageText(essay?.content || []),
          timestamp: typeof essay?.sent === "number" ? essay.sent : Date.now(),
          id: typeof seal?.id === "string" ? seal.id : undefined,
        } as TlonHistoryEntry;
      })
      .filter((msg) => msg.content);

    runtime?.log?.(`[tlon] Extracted ${messages.length} messages from history`);
    return messages;
  } catch (error: unknown) {
    runtime?.log?.(`[tlon] Error fetching channel history: ${formatErrorMessage(error)}`);
    return [];
  }
}

export async function getChannelHistory(
  api: { scry: (path: string) => Promise<unknown> },
  channelNest: string,
  count = 50,
  runtime?: RuntimeEnv,
): Promise<TlonHistoryEntry[]> {
  const cache = messageCache.get(channelNest) ?? [];
  if (cache.length >= count) {
    runtime?.log?.(`[tlon] Using cached messages (${cache.length} available)`);
    return cache.slice(0, count);
  }

  runtime?.log?.(`[tlon] Cache has ${cache.length} messages, need ${count}, fetching from scry...`);
  return await fetchChannelHistory(api, channelNest, count, runtime);
}

/**
 * Fetch thread/reply history for a specific parent post.
 * Used to get context when entering a thread conversation.
 */
export async function fetchThreadHistory(
  api: { scry: (path: string) => Promise<unknown> },
  channelNest: string,
  parentId: string,
  count = 50,
  runtime?: RuntimeEnv,
): Promise<TlonHistoryEntry[]> {
  try {
    // Tlon API: fetch replies to a specific post
    // Format: /channels/v4/{nest}/posts/post/{parentId}/replies/newest/{count}.json
    // parentId needs @ud formatting (dots every 3 digits)
    const formattedParentId = formatUd(parentId);
    runtime?.log?.(
      `[tlon] Thread history - parentId: ${parentId} -> formatted: ${formattedParentId}`,
    );

    const scryPath = `/channels/v4/${channelNest}/posts/post/id/${formattedParentId}/replies/newest/${count}.json`;
    runtime?.log?.(`[tlon] Fetching thread history: ${scryPath}`);

    const data: unknown = await api.scry(scryPath);
    if (!data) {
      runtime?.log?.(`[tlon] No thread history data returned`);
      return [];
    }

    let replies: unknown[] = [];
    if (Array.isArray(data)) {
      replies = data;
    } else {
      const dataRecord = asRecord(data);
      const replyValue = dataRecord?.replies;
      if (Array.isArray(replyValue)) {
        replies = replyValue;
      } else if (typeof replyValue === "object" && replyValue) {
        replies = Object.values(replyValue as Record<string, unknown>);
      } else if (dataRecord) {
        replies = Object.values(dataRecord);
      }
    }

    const messages = replies
      .map((item) => {
        // Thread replies use 'memo' structure
        const itemRecord = asRecord(item);
        const replyRecord = asRecord(itemRecord?.["r-reply"]);
        const replySet = asRecord(replyRecord?.set);
        const memo = asRecord(itemRecord?.memo) ?? asRecord(replySet?.memo) ?? itemRecord;
        const seal = asRecord(itemRecord?.seal) ?? asRecord(replySet?.seal);

        return createHistoryEntryFromMemo({ memo, seal, fallbackId: itemRecord?.id });
      })
      .filter((msg) => msg.content);

    runtime?.log?.(`[tlon] Extracted ${messages.length} thread replies from history`);
    return messages;
  } catch (error: unknown) {
    runtime?.log?.(`[tlon] Error fetching thread history: ${formatErrorMessage(error)}`);
    // Fall back to trying alternate path structure
    try {
      const altPath = `/channels/v4/${channelNest}/posts/post/id/${formatUd(parentId)}.json`;
      runtime?.log?.(`[tlon] Trying alternate path: ${altPath}`);
      const data = asRecord(await api.scry(altPath));
      const dataSeal = asRecord(data?.seal);
      const dataMeta = asRecord(dataSeal?.meta);
      const repliesValue = data?.replies;

      if (typeof dataMeta?.replyCount === "number" && dataMeta.replyCount > 0 && repliesValue) {
        const replies = Array.isArray(repliesValue)
          ? repliesValue
          : Object.values(repliesValue as Record<string, unknown>);
        const messages = replies
          .map((reply: unknown) => {
            const replyRecord = asRecord(reply);
            const memo = asRecord(replyRecord?.memo);
            const seal = asRecord(replyRecord?.seal);
            return createHistoryEntryFromMemo({ memo, seal });
          })
          .filter((msg: TlonHistoryEntry) => msg.content);

        runtime?.log?.(`[tlon] Extracted ${messages.length} replies from post data`);
        return messages;
      }
    } catch (altError: unknown) {
      runtime?.log?.(`[tlon] Alternate path also failed: ${formatErrorMessage(altError)}`);
    }
    return [];
  }
}
