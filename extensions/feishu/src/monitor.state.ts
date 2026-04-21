import * as http from "http";
import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  type RuntimeEnv,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS as WEBHOOK_ANOMALY_COUNTER_DEFAULTS_FROM_SDK,
  WEBHOOK_RATE_LIMIT_DEFAULTS as WEBHOOK_RATE_LIMIT_DEFAULTS_FROM_SDK,
} from "./monitor-state-runtime-api.js";

export const wsClients = new Map<string, Lark.WSClient>();
export const httpServers = new Map<string, http.Server>();
export const botOpenIds = new Map<string, string>();
export const botNames = new Map<string, string>();

export const FEISHU_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 5_000;

type WebhookRateLimitDefaults = {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
};

type WebhookAnomalyDefaults = {
  maxTrackedKeys: number;
  ttlMs: number;
  logEvery: number;
};

const FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS: WebhookRateLimitDefaults = {
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4_096,
};

const FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS: WebhookAnomalyDefaults = {
  maxTrackedKeys: 4_096,
  ttlMs: 6 * 60 * 60_000,
  logEvery: 25,
};

function coercePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

export function resolveFeishuWebhookRateLimitDefaultsForTest(
  defaults: unknown,
): WebhookRateLimitDefaults {
  const resolved = defaults as Partial<WebhookRateLimitDefaults> | null | undefined;
  return {
    windowMs: coercePositiveInt(
      resolved?.windowMs,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.windowMs,
    ),
    maxRequests: coercePositiveInt(
      resolved?.maxRequests,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxRequests,
    ),
    maxTrackedKeys: coercePositiveInt(
      resolved?.maxTrackedKeys,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxTrackedKeys,
    ),
  };
}

export function resolveFeishuWebhookAnomalyDefaultsForTest(
  defaults: unknown,
): WebhookAnomalyDefaults {
  const resolved = defaults as Partial<WebhookAnomalyDefaults> | null | undefined;
  return {
    maxTrackedKeys: coercePositiveInt(
      resolved?.maxTrackedKeys,
      FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.maxTrackedKeys,
    ),
    ttlMs: coercePositiveInt(resolved?.ttlMs, FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.ttlMs),
    logEvery: coercePositiveInt(
      resolved?.logEvery,
      FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.logEvery,
    ),
  };
}

const feishuWebhookRateLimitDefaults = resolveFeishuWebhookRateLimitDefaultsForTest(
  WEBHOOK_RATE_LIMIT_DEFAULTS_FROM_SDK,
);
const feishuWebhookAnomalyDefaults = resolveFeishuWebhookAnomalyDefaultsForTest(
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS_FROM_SDK,
);

export const feishuWebhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: feishuWebhookRateLimitDefaults.windowMs,
  maxRequests: feishuWebhookRateLimitDefaults.maxRequests,
  maxTrackedKeys: feishuWebhookRateLimitDefaults.maxTrackedKeys,
});

const feishuWebhookAnomalyTracker = createWebhookAnomalyTracker({
  maxTrackedKeys: feishuWebhookAnomalyDefaults.maxTrackedKeys,
  ttlMs: feishuWebhookAnomalyDefaults.ttlMs,
  logEvery: feishuWebhookAnomalyDefaults.logEvery,
});

function closeWsClient(client: Lark.WSClient | undefined): void {
  if (!client) {
    return;
  }
  try {
    client.close();
  } catch {
    /* Best-effort cleanup */
  }
}

export function clearFeishuWebhookRateLimitStateForTest(): void {
  feishuWebhookRateLimiter.clear();
  feishuWebhookAnomalyTracker.clear();
}

export function getFeishuWebhookRateLimitStateSizeForTest(): number {
  return feishuWebhookRateLimiter.size();
}

export function isWebhookRateLimitedForTest(key: string, nowMs: number): boolean {
  return feishuWebhookRateLimiter.isRateLimited(key, nowMs);
}

export function recordWebhookStatus(
  runtime: RuntimeEnv | undefined,
  accountId: string,
  path: string,
  statusCode: number,
): void {
  feishuWebhookAnomalyTracker.record({
    key: `${accountId}:${path}:${statusCode}`,
    statusCode,
    log: runtime?.log ?? console.log,
    message: (count) =>
      `feishu[${accountId}]: webhook anomaly path=${path} status=${statusCode} count=${count}`,
  });
}

export function stopFeishuMonitorState(accountId?: string): void {
  if (accountId) {
    closeWsClient(wsClients.get(accountId));
    wsClients.delete(accountId);
    const server = httpServers.get(accountId);
    if (server) {
      server.close();
      httpServers.delete(accountId);
    }
    botOpenIds.delete(accountId);
    botNames.delete(accountId);
    return;
  }

  for (const client of wsClients.values()) {
    closeWsClient(client);
  }
  wsClients.clear();
  for (const server of httpServers.values()) {
    server.close();
  }
  httpServers.clear();
  botOpenIds.clear();
  botNames.clear();
}
