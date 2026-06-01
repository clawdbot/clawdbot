import type { GatewayClient } from "./server-methods/types.js";

const CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS = 3;
const CONTROL_PLANE_RATE_LIMIT_WINDOW_MS = 60_000;
const CONTROL_PLANE_BUCKET_MAX_STALE_MS = 5 * 60_000;
/** Hard cap to prevent memory DoS from rapid unique-key injection (CWE-400). */
const CONTROL_PLANE_BUCKET_MAX_ENTRIES = 10_000;

/** Sliding-window counter keyed by device/IP identity for write-side control RPCs. */
type Bucket = {
  count: number;
  windowStartMs: number;
};

const controlPlaneBuckets = new Map<string, Bucket>();

function normalizePart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

/** Builds a stable throttle key while avoiding shared fallback buckets for anonymous clients. */
export function resolveControlPlaneRateLimitKey(client: GatewayClient | null): string {
  const deviceId = normalizePart(client?.connect?.device?.id, "unknown-device");
  const clientIp = normalizePart(client?.clientIp, "unknown-ip");
  if (deviceId === "unknown-device" && clientIp === "unknown-ip") {
    // Last-resort fallback: avoid cross-client contention when upstream identity is missing.
    const connId = normalizePart(client?.connId, "");
    if (connId) {
      return `${deviceId}|${clientIp}|conn=${connId}`;
    }
  }
  return `${deviceId}|${clientIp}`;
}

/** Consumes one write budget unit and reports retry state for gateway error responses. */
export function consumeControlPlaneWriteBudget(params: {
  client: GatewayClient | null;
  nowMs?: number;
}): {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  key: string;
} {
  const nowMs = params.nowMs ?? Date.now();
  const key = resolveControlPlaneRateLimitKey(params.client);
  const bucket = controlPlaneBuckets.get(key);

  if (!bucket || nowMs - bucket.windowStartMs >= CONTROL_PLANE_RATE_LIMIT_WINDOW_MS) {
    // Enforce hard cap before inserting a new key to bound memory usage
    // even between periodic prune sweeps.
    if (
      !controlPlaneBuckets.has(key) &&
      controlPlaneBuckets.size >= CONTROL_PLANE_BUCKET_MAX_ENTRIES
    ) {
      const oldest = controlPlaneBuckets.keys().next().value;
      if (oldest !== undefined) {
        controlPlaneBuckets.delete(oldest);
      }
    }
    controlPlaneBuckets.set(key, {
      count: 1,
      windowStartMs: nowMs,
    });
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - 1,
      key,
    };
  }

  if (bucket.count >= CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = Math.max(
      0,
      bucket.windowStartMs + CONTROL_PLANE_RATE_LIMIT_WINDOW_MS - nowMs,
    );
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      key,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - bucket.count),
    key,
  };
}

/**
 * Remove buckets whose rate-limit window expired more than
 * CONTROL_PLANE_BUCKET_MAX_STALE_MS ago.  Called periodically
 * by the gateway maintenance timer to prevent unbounded growth.
 */
export function pruneStaleControlPlaneBuckets(nowMs = Date.now()): number {
  let pruned = 0;
  for (const [key, bucket] of controlPlaneBuckets) {
    if (nowMs - bucket.windowStartMs > CONTROL_PLANE_BUCKET_MAX_STALE_MS) {
      controlPlaneBuckets.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}

export const testing = {
  getControlPlaneRateLimitBucketCount() {
    return controlPlaneBuckets.size;
  },
  resetControlPlaneRateLimitState() {
    controlPlaneBuckets.clear();
  },
};
export { testing as __testing };
