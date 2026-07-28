import crypto from "node:crypto";
import { closeActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveActiveMemoryCleanupConfig } from "./config.js";
import {
  CACHE_SWEEP_INTERVAL_MS,
  DEFAULT_MAX_CACHE_ENTRIES,
  MAX_LOG_VALUE_CHARS,
  type ActiveRecallResult,
  type CachedActiveRecallResult,
  type CircuitBreakerEntry,
} from "./types.js";

let lastActiveRecallCacheSweepAt = 0;
const activeRecallCache = new Map<string, CachedActiveRecallResult>();
const timeoutCircuitBreaker = new Map<string, CircuitBreakerEntry>();

function buildCircuitBreakerKey(agentId: string, provider?: string, model?: string): string {
  return `${agentId}:${provider ?? "unknown"}/${model ?? "unknown"}`;
}

function isCircuitBreakerOpen(key: string, maxTimeouts: number, cooldownMs: number): boolean {
  const entry = timeoutCircuitBreaker.get(key);
  if (!entry || entry.consecutiveTimeouts < maxTimeouts) {
    return false;
  }
  if (Date.now() - entry.lastTimeoutAt >= cooldownMs) {
    // Cooldown expired — reset and allow one attempt through.
    timeoutCircuitBreaker.delete(key);
    return false;
  }
  return true;
}

function recordCircuitBreakerTimeout(key: string): void {
  const entry = timeoutCircuitBreaker.get(key);
  if (entry) {
    entry.consecutiveTimeouts++;
    entry.lastTimeoutAt = Date.now();
  } else {
    timeoutCircuitBreaker.set(key, { consecutiveTimeouts: 1, lastTimeoutAt: Date.now() });
  }
}

function resetCircuitBreaker(key: string): void {
  timeoutCircuitBreaker.delete(key);
}

function scheduleMemorySearchCleanupAfterTimeout(
  api: OpenClawPluginApi,
  logPrefix: string,
  agentId: string,
): void {
  const cfg = resolveActiveMemoryCleanupConfig(api);
  setTimeout(() => {
    void closeActiveMemorySearchManager({ cfg: cfg ?? api.config, agentId })
      .then(() => {
        api.logger.debug?.(`${logPrefix} released memory search managers after timeout`);
      })
      .catch((error: unknown) => {
        const message = toSingleLineLogValue(
          error instanceof Error ? error.message : String(error),
        );
        api.logger.warn?.(
          `${logPrefix} failed to release memory search managers after timeout: ${message}`,
        );
      });
  }, 0);
}

function buildCacheKey(params: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
}): string {
  const hash = crypto.createHash("sha1").update(params.query).digest("hex");
  return `${params.agentId}:${params.sessionKey ?? params.sessionId ?? "none"}:${hash}`;
}

function getCachedResult(cacheKey: string): ActiveRecallResult | undefined {
  const cached = activeRecallCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  const now = asDateTimestampMs(Date.now());
  if (
    now === undefined ||
    asDateTimestampMs(cached.expiresAt) === undefined ||
    cached.expiresAt <= now
  ) {
    activeRecallCache.delete(cacheKey);
    return undefined;
  }
  return cached.result;
}

function setCachedResult(cacheKey: string, result: ActiveRecallResult, ttlMs: number): void {
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  if (
    activeRecallCache.size >= DEFAULT_MAX_CACHE_ENTRIES ||
    (now !== undefined && now - lastActiveRecallCacheSweepAt >= CACHE_SWEEP_INTERVAL_MS)
  ) {
    sweepExpiredCacheEntries(now);
    if (now !== undefined) {
      lastActiveRecallCacheSweepAt = now;
    }
  }
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
  if (expiresAt === undefined) {
    activeRecallCache.delete(cacheKey);
    return;
  }
  if (activeRecallCache.has(cacheKey)) {
    activeRecallCache.delete(cacheKey);
  }
  activeRecallCache.set(cacheKey, {
    expiresAt,
    result,
  });
  while (activeRecallCache.size > DEFAULT_MAX_CACHE_ENTRIES) {
    const oldestKey = activeRecallCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    activeRecallCache.delete(oldestKey);
  }
}

function sweepExpiredCacheEntries(now = asDateTimestampMs(Date.now())): void {
  if (now === undefined) {
    activeRecallCache.clear();
    return;
  }
  for (const [cacheKey, cached] of activeRecallCache.entries()) {
    if (asDateTimestampMs(cached.expiresAt) === undefined || cached.expiresAt <= now) {
      activeRecallCache.delete(cacheKey);
    }
  }
}

function toSingleLineLogValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint" ||
          typeof value === "symbol"
        ? String(value)
        : value == null
          ? ""
          : JSON.stringify(value);
  const singleLine = raw
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > MAX_LOG_VALUE_CHARS
    ? `${truncateUtf16Safe(singleLine, MAX_LOG_VALUE_CHARS)}...`
    : singleLine;
}

function shouldCacheResult(result: ActiveRecallResult): boolean {
  return result.status === "ok" && result.summary.length > 0;
}

function resetActiveRecallStateForTests(): void {
  activeRecallCache.clear();
  timeoutCircuitBreaker.clear();
  lastActiveRecallCacheSweepAt = 0;
}

function getCircuitBreakerEntry(key: string): CircuitBreakerEntry | undefined {
  return timeoutCircuitBreaker.get(key);
}

export {
  buildCacheKey,
  buildCircuitBreakerKey,
  getCachedResult,
  getCircuitBreakerEntry,
  isCircuitBreakerOpen,
  recordCircuitBreakerTimeout,
  resetActiveRecallStateForTests,
  resetCircuitBreaker,
  scheduleMemorySearchCleanupAfterTimeout,
  setCachedResult,
  shouldCacheResult,
  toSingleLineLogValue,
};
