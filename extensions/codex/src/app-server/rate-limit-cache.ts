/**
 * Keeps the latest Codex app-server rate-limit payload in process-global state
 * so failure handling can enrich later usage-limit errors.
 */
import type { JsonValue } from "./protocol.js";

const DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS = 10 * 60_000;
const CODEX_RATE_LIMIT_CACHE_STATE = Symbol.for("openclaw.codexRateLimitCacheState");

type CodexRateLimitCacheState = {
  value?: JsonValue;
  updatedAtMs?: number;
};

function getCodexRateLimitCacheState(): CodexRateLimitCacheState {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_RATE_LIMIT_CACHE_STATE]?: CodexRateLimitCacheState;
  };
  globalState[CODEX_RATE_LIMIT_CACHE_STATE] ??= {};
  return globalState[CODEX_RATE_LIMIT_CACHE_STATE];
}

/** Stores a non-empty Codex rate-limit payload with its observation time. */
export function rememberCodexRateLimits(value: JsonValue | undefined, nowMs = Date.now()): void {
  if (value === undefined) {
    return;
  }
  const state = getCodexRateLimitCacheState();
  state.value = value;
  state.updatedAtMs = nowMs;
}

/** Reads the cached Codex rate-limit payload when it is still within the max-age window. */
export function readRecentCodexRateLimits(options?: {
  nowMs?: number;
  maxAgeMs?: number;
}): JsonValue | undefined {
  const state = getCodexRateLimitCacheState();
  if (state.value === undefined || state.updatedAtMs === undefined) {
    return undefined;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS;
  if (maxAgeMs >= 0 && nowMs - state.updatedAtMs > maxAgeMs) {
    return undefined;
  }
  return state.value;
}

/** Clears the process-global rate-limit cache for deterministic tests. */
export function resetCodexRateLimitCacheForTests(): void {
  const state = getCodexRateLimitCacheState();
  state.value = undefined;
  state.updatedAtMs = undefined;
}
