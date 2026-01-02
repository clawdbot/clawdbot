/**
 * This module MUST be imported before any other modules that use fetch.
 * It wraps globalThis.fetch to capture Anthropic rate limit headers.
 *
 * Import at the very top of src/index.ts:
 *   import "./infra/fetch-intercept-bootstrap.js";
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".clawdis");
const SNAPSHOT_PATH = path.join(CONFIG_DIR, "rate-limits.json");
const FETCH_WRAPPED = Symbol.for("clawdis.anthropicRateLimitFetch");

// Claude Max uses unified rate limit headers
const HEADER_5H_UTILIZATION = "anthropic-ratelimit-unified-5h-utilization";
const HEADER_5H_RESET = "anthropic-ratelimit-unified-5h-reset";
const HEADER_5H_STATUS = "anthropic-ratelimit-unified-5h-status";
const HEADER_7D_UTILIZATION = "anthropic-ratelimit-unified-7d-utilization";
const HEADER_7D_RESET = "anthropic-ratelimit-unified-7d-reset";
const HEADER_7D_STATUS = "anthropic-ratelimit-unified-7d-status";
const HEADER_FALLBACK = "anthropic-ratelimit-unified-fallback";
const HEADER_FALLBACK_PCT = "anthropic-ratelimit-unified-fallback-percentage";
const HEADER_REPRESENTATIVE = "anthropic-ratelimit-unified-representative-claim";

// API-tier standard headers (kept for non-Max subscriptions)
const HEADER_LIMIT_REQUESTS = "x-ratelimit-limit-requests";
const HEADER_LIMIT_TOKENS = "x-ratelimit-limit-tokens";
const HEADER_REMAINING_REQUESTS = "x-ratelimit-remaining-requests";
const HEADER_REMAINING_TOKENS = "x-ratelimit-remaining-tokens";
const HEADER_RESET_REQUESTS = "x-ratelimit-reset-requests";
const HEADER_RESET_TOKENS = "x-ratelimit-reset-tokens";

type UnifiedWindow = {
  utilization: number;      // 0-1 percentage used
  resetAt: string;          // ISO timestamp
  status: string;           // "allowed" | "rejected"
};

type StandardWindow = {
  limit?: number;
  remaining?: number;
  resetAt?: string;
};

type RateLimitSnapshot = {
  provider: "anthropic";
  capturedAt: string;
  source?: { url?: string };
  type: "unified" | "standard";
  
  // Claude Max unified limits
  unified?: {
    fiveHour?: UnifiedWindow;
    sevenDay?: UnifiedWindow;
    fallback?: string;           // "available" | "unavailable"
    fallbackPercentage?: number; // 0-1
    representativeClaim?: string; // which window is representative
  };
  
  // Standard API tier limits
  requests?: StandardWindow;
  tokens?: StandardWindow;
};

const parseNumber = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseTimestamp = (value: string | null): string | undefined => {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    // Unix timestamp (seconds)
    const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  return undefined;
};

const buildSnapshot = (
  headers: Headers,
  url?: string,
): RateLimitSnapshot | null => {
  // Check for Claude Max unified headers first
  const util5h = parseNumber(headers.get(HEADER_5H_UTILIZATION));
  const util7d = parseNumber(headers.get(HEADER_7D_UTILIZATION));
  
  if (util5h !== undefined || util7d !== undefined) {
    const snapshot: RateLimitSnapshot = {
      provider: "anthropic",
      capturedAt: new Date().toISOString(),
      type: "unified",
    };
    if (url) snapshot.source = { url };
    
    snapshot.unified = {};
    
    if (util5h !== undefined) {
      snapshot.unified.fiveHour = {
        utilization: util5h,
        resetAt: parseTimestamp(headers.get(HEADER_5H_RESET)) || "",
        status: headers.get(HEADER_5H_STATUS) || "unknown",
      };
    }
    
    if (util7d !== undefined) {
      snapshot.unified.sevenDay = {
        utilization: util7d,
        resetAt: parseTimestamp(headers.get(HEADER_7D_RESET)) || "",
        status: headers.get(HEADER_7D_STATUS) || "unknown",
      };
    }
    
    const fallback = headers.get(HEADER_FALLBACK);
    if (fallback) snapshot.unified.fallback = fallback;
    
    const fallbackPct = parseNumber(headers.get(HEADER_FALLBACK_PCT));
    if (fallbackPct !== undefined) snapshot.unified.fallbackPercentage = fallbackPct;
    
    const representative = headers.get(HEADER_REPRESENTATIVE);
    if (representative) snapshot.unified.representativeClaim = representative;
    
    return snapshot;
  }
  
  // Fall back to standard API tier headers
  const limitRequests = parseNumber(headers.get(HEADER_LIMIT_REQUESTS));
  const limitTokens = parseNumber(headers.get(HEADER_LIMIT_TOKENS));
  const remainingRequests = parseNumber(headers.get(HEADER_REMAINING_REQUESTS));
  const remainingTokens = parseNumber(headers.get(HEADER_REMAINING_TOKENS));
  const resetRequests = parseTimestamp(headers.get(HEADER_RESET_REQUESTS));
  const resetTokens = parseTimestamp(headers.get(HEADER_RESET_TOKENS));

  const hasAny =
    limitRequests !== undefined ||
    limitTokens !== undefined ||
    remainingRequests !== undefined ||
    remainingTokens !== undefined ||
    resetRequests !== undefined ||
    resetTokens !== undefined;

  if (!hasAny) return null;

  const snapshot: RateLimitSnapshot = {
    provider: "anthropic",
    capturedAt: new Date().toISOString(),
    type: "standard",
  };
  if (url) snapshot.source = { url };

  if (limitRequests !== undefined || remainingRequests !== undefined || resetRequests !== undefined) {
    snapshot.requests = {
      limit: limitRequests,
      remaining: remainingRequests,
      resetAt: resetRequests,
    };
  }

  if (limitTokens !== undefined || remainingTokens !== undefined || resetTokens !== undefined) {
    snapshot.tokens = {
      limit: limitTokens,
      remaining: remainingTokens,
      resetAt: resetTokens,
    };
  }

  return snapshot;
};

const writeSnapshot = async (snapshot: RateLimitSnapshot): Promise<void> => {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Ignore write errors
  }
};

// Wrap fetch immediately on module load
const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function" && !(originalFetch as any)[FETCH_WRAPPED]) {
  const wrappedFetch: typeof fetch = async (input, init) => {
    const response = await originalFetch.call(undefined, input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      // Only process anthropic API calls
      if (url?.includes("anthropic.com")) {
        const snapshot = buildSnapshot(response.headers, response.url || url);
        if (snapshot) {
          if (snapshot.type === "unified" && snapshot.unified?.fiveHour) {
            const pct = (snapshot.unified.fiveHour.utilization * 100).toFixed(1);
            console.log(`[rate-limit] Claude Max: ${pct}% of 5h window used`);
          }
          void writeSnapshot(snapshot);
        }
      }
    } catch {
      // Ignore capture errors
    }
    return response;
  };
  (wrappedFetch as any)[FETCH_WRAPPED] = true;
  globalThis.fetch = wrappedFetch;
  console.log("[rate-limit] Fetch wrapper installed");
}

export type { RateLimitSnapshot, UnifiedWindow, StandardWindow };
