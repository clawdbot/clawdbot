import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";
import type {
  RateLimitSnapshot,
  StandardWindow,
} from "./fetch-intercept-bootstrap.js";

const SNAPSHOT_PATH = path.join(CONFIG_DIR, "rate-limits.json");
const FETCH_WRAPPED = Symbol.for("clawdis.anthropicRateLimitFetch");

const HEADER_LIMIT_REQUESTS = "x-ratelimit-limit-requests";
const HEADER_LIMIT_TOKENS = "x-ratelimit-limit-tokens";
const HEADER_REMAINING_REQUESTS = "x-ratelimit-remaining-requests";
const HEADER_REMAINING_TOKENS = "x-ratelimit-remaining-tokens";
const HEADER_RESET_REQUESTS = "x-ratelimit-reset-requests";
const HEADER_RESET_TOKENS = "x-ratelimit-reset-tokens";

export type AnthropicRateLimitWindow = StandardWindow;
export type AnthropicRateLimitSnapshot = RateLimitSnapshot;

const parseHeaderNumber = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
};

const parseResetAt = (value: string | null): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
};

const buildSnapshot = (
  headers: Headers,
  url?: string,
  now = new Date(),
): RateLimitSnapshot | null => {
  const limitRequests = parseHeaderNumber(headers.get(HEADER_LIMIT_REQUESTS));
  const limitTokens = parseHeaderNumber(headers.get(HEADER_LIMIT_TOKENS));
  const remainingRequests = parseHeaderNumber(
    headers.get(HEADER_REMAINING_REQUESTS),
  );
  const remainingTokens = parseHeaderNumber(
    headers.get(HEADER_REMAINING_TOKENS),
  );
  const resetRequests = parseResetAt(headers.get(HEADER_RESET_REQUESTS));
  const resetTokens = parseResetAt(headers.get(HEADER_RESET_TOKENS));

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
    capturedAt: now.toISOString(),
    type: "standard",
  };
  if (url) snapshot.source = { url };

  if (
    limitRequests !== undefined ||
    remainingRequests !== undefined ||
    resetRequests !== undefined
  ) {
    snapshot.requests = {
      limit: limitRequests,
      remaining: remainingRequests,
      resetAt: resetRequests,
    };
  }

  if (
    limitTokens !== undefined ||
    remainingTokens !== undefined ||
    resetTokens !== undefined
  ) {
    snapshot.tokens = {
      limit: limitTokens,
      remaining: remainingTokens,
      resetAt: resetTokens,
    };
  }

  return snapshot;
};

export async function writeAnthropicRateLimitSnapshot(
  snapshot: AnthropicRateLimitSnapshot,
): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function readAnthropicRateLimitSnapshot(): Promise<
  AnthropicRateLimitSnapshot | null
> {
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw) as RateLimitSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.provider !== "anthropic") return null;
    if (parsed.type !== "standard" && parsed.type !== "unified") {
      const inferredType = parsed.unified ? "unified" : "standard";
      return { ...parsed, type: inferredType };
    }
    return parsed;
  } catch {
    return null;
  }
}

export function ensureAnthropicRateLimitMiddleware(): void {
  const fetchImpl = globalThis.fetch as typeof fetch | undefined;
  if (typeof fetchImpl !== "function") return;
  if ((fetchImpl as unknown as Record<symbol, boolean>)[FETCH_WRAPPED]) return;

  const wrapped: typeof fetch = async (input, init) => {
    const response = await fetchImpl.call(undefined, input, init);
    try {
      const snapshot = buildSnapshot(
        response.headers,
        response.url || undefined,
      );
      if (snapshot) {
        void writeAnthropicRateLimitSnapshot(snapshot);
      }
    } catch {
      // Ignore rate-limit capture errors.
    }
    return response;
  };

  (wrapped as unknown as Record<symbol, boolean>)[FETCH_WRAPPED] = true;
  globalThis.fetch = wrapped;
}
