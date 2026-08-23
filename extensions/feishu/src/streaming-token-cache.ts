// Feishu plugin module implements CardKit streaming token cache.
import {
  asDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { FEISHU_HTTP_TIMEOUT_MS } from "./client-timeout.js";
import { clearClientCache, getFeishuUserAgent } from "./client.js";
import { addFeishuTokenCacheClearer } from "./comment-shared.js";
import { readFeishuJsonResponse } from "./json-response.js";
import type { FeishuDomain } from "./types.js";

const FEISHU_STREAMING_TOKEN_DEFAULT_LIFETIME_SECONDS = 7200;

export type StreamingCredentials = {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
  httpTimeoutMs?: number;
};

export type StreamingFetch = typeof fetch;

export type StreamingDeps = {
  /** Override fetch for tests while preserving the real SSRF guard path. */
  fetchImpl?: StreamingFetch;
  /** Override hostname lookup for hermetic SSRF-guard tests. */
  lookupFn?: LookupFn;
};

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Maps accountId to its tokenCache key (domain|appId) so clearFeishuTokenCache
// can invalidate only the affected account's CardKit token (#97287).
const accountIdToCacheKey = new Map<string, string>();

/** Clear cached CardKit tokens for an account so the next getToken() call
 *  fetches fresh tokens.  Registered with requestFeishuApi via
 *  addFeishuTokenCacheClearer (#97287).  When accountId is provided, only
 *  that account's tokenCache entry and client cache entry are invalidated;
 *  other accounts' tokens remain warm. */
function clearFeishuTokenCache(accountId?: string): void {
  if (accountId) {
    const cacheKey = accountIdToCacheKey.get(accountId);
    if (cacheKey) {
      tokenCache.delete(cacheKey);
    }
  } else {
    tokenCache.clear();
  }
  clearClientCache(accountId);
}

addFeishuTokenCacheClearer(clearFeishuTokenCache);

/** Register an account's token cache key so clearFeishuTokenCache can
 *  invalidate the right entry on a token-invalid retry (#97287). */
export function registerStreamingAccount(accountId: string, creds: StreamingCredentials): void {
  accountIdToCacheKey.set(accountId, `${creds.domain ?? "feishu"}|${creds.appId}`);
}

function resolveStreamingTokenExpiresAt(value: unknown, nowMs = Date.now()): number {
  const now = resolveDateTimestampMs(nowMs);
  if (typeof value === "number" && Number.isFinite(value) && value <= 0) {
    return now;
  }
  return (
    resolveExpiresAtMsFromDurationSeconds(value, { nowMs: now }) ??
    resolveExpiresAtMsFromDurationSeconds(FEISHU_STREAMING_TOKEN_DEFAULT_LIFETIME_SECONDS, {
      nowMs: now,
    }) ??
    now
  );
}

export function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

export function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

export async function getStreamingToken(
  creds: StreamingCredentials,
  deps?: StreamingDeps,
): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  const rawNow = Date.now();
  const hasValidClock = asDateTimestampMs(rawNow) !== undefined;
  const now = resolveDateTimestampMs(rawNow);
  const minUsableExpiresAt = resolveExpiresAtMsFromDurationSeconds(60, { nowMs: now }) ?? now;
  if (cached && hasValidClock && cached.expiresAt > minUsableExpiresAt) {
    return cached.token;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": getFeishuUserAgent() },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
    fetchImpl: deps?.fetchImpl,
    lookupFn: deps?.lookupFn,
    policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
    auditContext: "feishu.streaming-card.token",
    timeoutMs: creds.httpTimeoutMs ?? FEISHU_HTTP_TIMEOUT_MS,
  });
  let data: {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  try {
    if (!response.ok) {
      if (!response.bodyUsed) {
        void response.body?.cancel().catch(() => undefined);
      }
      throw new Error(`Token request failed with HTTP ${response.status}`);
    }
    data = await readFeishuJsonResponse(response, "feishu.streaming-card.token");
  } finally {
    await release();
  }
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: resolveStreamingTokenExpiresAt(data.expire, now),
  });
  return data.tenant_access_token;
}

/** Clear the streaming token cache for an account so the next token fetch
 *  gets fresh credentials.  Used by streaming-card retry logic (#97287). */
export function clearStreamingTokenCache(accountId?: string): void {
  clearFeishuTokenCache(accountId);
}
