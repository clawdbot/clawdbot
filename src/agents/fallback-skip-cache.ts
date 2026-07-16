/**
 * Session-scoped "known-bad candidate" cache for the model fallback chain.
 *
 * When explicitly enabled and a fallback candidate fails with a non-transient
 * credential error (`auth` / `auth_permanent`), the chain can avoid retrying
 * the same candidate on every subsequent turn until the user fixes their auth.
 *
 * This module records skip markers per `(sessionId, provider, model)` with a
 * short TTL. The cache is intentionally in-memory only: a process restart
 * clears it so a freshly-restarted gateway always tries every candidate at
 * least once before deciding to skip again.
 *
 * The cache is global, not per-config, so any caller running fallbacks for the
 * same `sessionId` shares the same skip set.
 */

import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { modelKey } from "./model-selection-normalize.js";

/**
 * Default time-to-live for a skip marker. Disabled by default so existing
 * fallback retry behavior stays unchanged unless an operator opts in with
 * OPENCLAW_FALLBACK_SKIP_TTL_MS.
 */
const DEFAULT_FALLBACK_SKIP_TTL_MS = 0;
const FALLBACK_SKIP_TTL_ENV = "OPENCLAW_FALLBACK_SKIP_TTL_MS";
const FALLBACK_SKIP_TTL_MIN_MS = 1_000;
const FALLBACK_SKIP_TTL_MAX_MS = 10 * 60_000;

function resolveConfiguredSkipTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FALLBACK_SKIP_TTL_ENV];
  if (!raw) {
    return DEFAULT_FALLBACK_SKIP_TTL_MS;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_FALLBACK_SKIP_TTL_MS;
  }
  const parsed = parseStrictNonNegativeInteger(trimmed);
  if (parsed === undefined) {
    return DEFAULT_FALLBACK_SKIP_TTL_MS;
  }
  if (parsed === 0) {
    return 0;
  }
  return Math.min(FALLBACK_SKIP_TTL_MAX_MS, Math.max(FALLBACK_SKIP_TTL_MIN_MS, parsed));
}

type SkipEntry = {
  expiresAtMs: number;
  reason: string;
};

type SkipBySession = Map<string, Map<string, SkipEntry>>;

type SkipCacheState = {
  buckets: SkipBySession;
  lastGlobalPruneAtMs: number;
};

/**
 * Minimum interval between two opportunistic global prunes. Keeps the
 * worst-case cost of a hot write/check path amortized: even if a gateway
 * tracks thousands of sessions, the cache is only walked every
 * `GLOBAL_PRUNE_INTERVAL_MS`, not on every call.
 */
const GLOBAL_PRUNE_INTERVAL_MS = 5_000;

function getState(): SkipCacheState {
  const globalStore = globalThis as typeof globalThis & {
    openclawFallbackSkipCache?: SkipBySession;
    openclawFallbackSkipCacheState?: SkipCacheState;
  };
  if (!globalStore.openclawFallbackSkipCacheState) {
    // Reuse the existing buckets map if a prior version of this module already
    // populated the legacy global; otherwise start fresh.
    const buckets = globalStore.openclawFallbackSkipCache ?? new Map();
    globalStore.openclawFallbackSkipCacheState = {
      buckets,
      lastGlobalPruneAtMs: 0,
    };
    globalStore.openclawFallbackSkipCache = buckets;
  }
  return globalStore.openclawFallbackSkipCacheState;
}

function getBuckets(): SkipBySession {
  return getState().buckets;
}

function sessionBucket(sessionId: string, create: boolean): Map<string, SkipEntry> | undefined {
  const buckets = getBuckets();
  let bucket = buckets.get(sessionId);
  if (!bucket && create) {
    bucket = new Map();
    buckets.set(sessionId, bucket);
  }
  return bucket;
}

function candidateKey(provider: string, model: string): string {
  return modelKey(provider, model);
}

function pruneExpired(bucket: Map<string, SkipEntry>, now: number): void {
  for (const [key, entry] of bucket.entries()) {
    if (entry.expiresAtMs <= now) {
      bucket.delete(key);
    }
  }
}

/**
 * Walk every session bucket, drop expired markers, and remove buckets that
 * end up empty. Called opportunistically from the hot write/check paths so
 * stale buckets left behind by one-off sessions cannot accumulate across the
 * gateway's lifetime — the per-bucket prune only fires when the same session
 * is queried again, which is not guaranteed for short-lived sessions.
 */
function pruneAllExpired(now: number): void {
  const state = getState();
  if (now - state.lastGlobalPruneAtMs < GLOBAL_PRUNE_INTERVAL_MS) {
    return;
  }
  state.lastGlobalPruneAtMs = now;
  for (const [sessionId, bucket] of state.buckets.entries()) {
    pruneExpired(bucket, now);
    if (bucket.size === 0) {
      state.buckets.delete(sessionId);
    }
  }
}

/**
 * Record that `(sessionId, provider, model)` should be skipped for the
 * configured TTL. Safe to call with falsy `sessionId` — the call becomes a
 * no-op so callers do not need to guard themselves.
 */
export function markFallbackCandidateSkipped(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  reason: string;
  now?: number;
  ttlMs?: number;
}): void {
  if (!params.sessionId || !params.provider || !params.model) {
    return;
  }
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? resolveConfiguredSkipTtlMs();
  if (ttlMs <= 0) {
    return;
  }
  pruneAllExpired(now);
  const bucket = sessionBucket(params.sessionId, true);
  if (!bucket) {
    return;
  }
  bucket.set(candidateKey(params.provider, params.model), {
    expiresAtMs: now + ttlMs,
    reason: params.reason,
  });
}

/**
 * Returns true when `(sessionId, provider, model)` has an unexpired skip
 * marker. Expired entries are pruned as a side-effect so the cache does not
 * grow unbounded.
 */
export function isFallbackCandidateSkipped(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  now?: number;
}): boolean {
  if (!params.sessionId || !params.provider || !params.model) {
    return false;
  }
  const now = params.now ?? Date.now();
  pruneAllExpired(now);
  const bucket = sessionBucket(params.sessionId, false);
  if (!bucket) {
    return false;
  }
  pruneExpired(bucket, now);
  if (bucket.size === 0) {
    getBuckets().delete(params.sessionId);
    return false;
  }
  const entry = bucket.get(candidateKey(params.provider, params.model));
  return Boolean(entry && entry.expiresAtMs > now);
}

/**
 * Look up the recorded skip reason for a `(sessionId, provider, model)`
 * triple. Returns `undefined` when no unexpired marker exists. Used by the
 * fallback chain to surface the original failure reason in observation logs.
 */
export function getFallbackCandidateSkipReason(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  now?: number;
}): string | undefined {
  if (!params.sessionId || !params.provider || !params.model) {
    return undefined;
  }
  const bucket = sessionBucket(params.sessionId, false);
  if (!bucket) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const entry = bucket.get(candidateKey(params.provider, params.model));
  if (!entry || entry.expiresAtMs <= now) {
    return undefined;
  }
  return entry.reason;
}
