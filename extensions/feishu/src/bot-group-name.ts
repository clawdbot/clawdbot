import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import { getChatInfo } from "./chat.js";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

const GROUP_NAME_CACHE_TTL_MS = 30 * 60 * 1000;
const GROUP_NAME_CACHE_MAX_SIZE = 500;

function evictGroupNameCache(): void {
  const now = asDateTimestampMs(Date.now());
  if (now === undefined) {
    feishuGroupNameCache.clear();
    return;
  }
  for (const [key, value] of feishuGroupNameCache) {
    const expiresAt = asDateTimestampMs(value.expiresAt);
    if (expiresAt === undefined || expiresAt <= now) {
      feishuGroupNameCache.delete(key);
    }
  }

  const excess = feishuGroupNameCache.size - GROUP_NAME_CACHE_MAX_SIZE;
  if (excess <= 0) {
    return;
  }
  let removed = 0;
  for (const key of feishuGroupNameCache.keys()) {
    if (removed >= excess) {
      break;
    }
    feishuGroupNameCache.delete(key);
    removed++;
  }
}

function setCacheEntry(key: string, name: string): void {
  const expiresAt = resolveExpiresAtMsFromDurationMs(GROUP_NAME_CACHE_TTL_MS);
  feishuGroupNameCache.delete(key);
  if (expiresAt !== undefined) {
    feishuGroupNameCache.set(key, { name, expiresAt });
  }
}

export async function resolveGroupName(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  log: (...args: unknown[]) => void;
}): Promise<string | undefined> {
  const { account, chatId, log } = params;
  if (!account.configured) {
    return undefined;
  }

  const cacheKey = `${account.accountId}:${chatId}`;
  const cached = feishuGroupNameCache.get(cacheKey);
  if (cached) {
    const now = asDateTimestampMs(Date.now());
    const expiresAt = asDateTimestampMs(cached.expiresAt);
    if (now !== undefined && expiresAt !== undefined && expiresAt > now) {
      return cached.name || undefined;
    }
    feishuGroupNameCache.delete(cacheKey);
  }

  let resolvedName: string | undefined;
  try {
    const client = createFeishuClient(account);
    const chatInfo = await getChatInfo(client, chatId);
    const name = chatInfo?.name?.trim();
    if (name) {
      setCacheEntry(cacheKey, name);
      resolvedName = name;
    } else {
      setCacheEntry(cacheKey, "");
    }
  } catch (err) {
    log(`feishu[${account.accountId}]: getChatInfo failed for ${chatId}: ${String(err)}`);
    setCacheEntry(cacheKey, "");
  }

  evictGroupNameCache();
  return resolvedName;
}
