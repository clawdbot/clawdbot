// Feishu plugin module implements bot sender name resolution.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

type FeishuLogger = (...args: unknown[]) => void;
type CacheEntry = { name?: string; expiresAt: number };
type BreakerState = { failures: number; openUntil: number };
type BotBatchResponse = {
  code?: number;
  msg?: string;
  data?: { bots?: Record<string, { name?: string }> };
};
type BotBatchResult = BotBatchResponse | "permission" | "failure";
type BotNameClient = ReturnType<typeof createFeishuClient> & {
  request(params: { method: "GET"; url: string; timeout: number }): Promise<unknown>;
};

const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
const BREAKER_FAILURE_THRESHOLD = 10;
const BREAKER_OPEN_MS = 60 * 60_000;
const PERMISSION_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 1_500;

const cache = new Map<string, CacheEntry>();
const breakerByAccount = new Map<string, BreakerState>();
const permissionBackoffUntilByAccount = new Map<string, number>();
const inflight = new Map<string, Promise<string | undefined>>();

function resolveCacheKey(accountId: string, openId: string): string {
  return `${accountId}::${openId}`;
}

function readCache(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCache(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  pruneMapToMaxSize(cache, MAX_CACHE_ENTRIES);
}

function isBreakerOpen(accountId: string): boolean {
  const state = breakerByAccount.get(accountId);
  if (!state) {
    return false;
  }
  if (state.openUntil > Date.now()) {
    return true;
  }
  if (state.openUntil > 0) {
    breakerByAccount.delete(accountId);
  }
  return false;
}

function recordFailure(accountId: string): void {
  const state = breakerByAccount.get(accountId) ?? { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= BREAKER_FAILURE_THRESHOLD) {
    state.failures = 0;
    state.openUntil = Date.now() + BREAKER_OPEN_MS;
  }
  breakerByAccount.set(accountId, state);
}

function recordSuccess(accountId: string): void {
  breakerByAccount.delete(accountId);
}

function readFeishuErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const data = (error as { response?: { data?: unknown } }).response?.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const code = (data as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

async function requestBotName(params: {
  account: ResolvedFeishuAccount;
  openId: string;
  log: FeishuLogger;
}): Promise<BotBatchResult> {
  const { account, openId, log } = params;
  const query = new URLSearchParams({ bot_ids: openId });
  try {
    const client = createFeishuClient(account) as BotNameClient;
    const response = (await client.request({
      method: "GET",
      url: `/open-apis/bot/v3/bots/basic_batch?${query.toString()}`,
      timeout: REQUEST_TIMEOUT_MS,
    })) as BotBatchResponse;
    const code = response.code ?? 0;
    if (code === 0) {
      return response;
    }
    if (code === 99991672) {
      log(`feishu[${account.accountId}]: bot.basic_info scope not granted`);
      return "permission";
    }
    log(`feishu[${account.accountId}]: bot name lookup failed (code=${code})`);
    return "failure";
  } catch (error) {
    if (readFeishuErrorCode(error) === 99991672) {
      log(`feishu[${account.accountId}]: bot.basic_info scope not granted`);
      return "permission";
    }
    log(`feishu[${account.accountId}]: bot name lookup failed: ${String(error)}`);
    return "failure";
  }
}

async function resolveUncachedBotName(params: {
  account: ResolvedFeishuAccount;
  openId: string;
  cacheKey: string;
  log: FeishuLogger;
}): Promise<string | undefined> {
  const { account, openId, cacheKey, log } = params;
  if (isBreakerOpen(account.accountId)) {
    log(`feishu[${account.accountId}]: bot name lookup skipped (breaker open)`);
    return undefined;
  }
  const result = await requestBotName({ account, openId, log });
  if (result === "permission") {
    // Optional scope. Keep this out of the failure breaker, but avoid one request
    // per message while still picking up a newly granted scope without restart.
    permissionBackoffUntilByAccount.set(account.accountId, Date.now() + PERMISSION_BACKOFF_MS);
    return undefined;
  }
  if (result === "failure") {
    recordFailure(account.accountId);
    return undefined;
  }

  recordSuccess(account.accountId);
  const name = result.data?.bots?.[openId]?.name?.trim();
  writeCache(cacheKey, {
    ...(name ? { name } : {}),
    expiresAt: Date.now() + (name ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
  return name;
}

export async function resolveFeishuBotName(params: {
  account: ResolvedFeishuAccount;
  openId: string;
  log: FeishuLogger;
}): Promise<string | undefined> {
  const openId = params.openId.trim();
  if (!params.account.configured || !openId) {
    return undefined;
  }
  const permissionBackoffUntil = permissionBackoffUntilByAccount.get(params.account.accountId);
  if (permissionBackoffUntil !== undefined) {
    if (permissionBackoffUntil > Date.now()) {
      return undefined;
    }
    permissionBackoffUntilByAccount.delete(params.account.accountId);
  }
  const key = resolveCacheKey(params.account.accountId, openId);
  const cached = readCache(key);
  if (cached) {
    return cached.name;
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const lookup = resolveUncachedBotName({ ...params, openId, cacheKey: key });
  inflight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    inflight.delete(key);
  }
}
