/**
 * Continuation runtime configuration resolution.
 *
 * Reads from `agents.defaults.continuation` in the gateway config.
 * Values are clamped to safe ranges. Hot-reloadable — reads happen at each
 * enforcement point, not at process start.
 *
 * RFC: docs/design/continue-work-signal-v2.md §5
 */

import { getRuntimeConfig, getRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContinuationRuntimeConfig } from "./types.js";

const DEFAULT_CONTINUATION_DELAY_MS = 15_000;
const DEFAULT_CONTINUATION_MIN_DELAY_MS = 5_000;
const DEFAULT_CONTINUATION_MAX_DELAY_MS = 300_000;
const DEFAULT_CONTINUATION_MAX_CHAIN_LENGTH = 10;
const DEFAULT_CONTINUATION_COST_CAP_TOKENS = 500_000;
const DEFAULT_CONTINUATION_MAX_DELEGATES_PER_TURN = 5;
const DEFAULT_CONTINUATION_MAX_PENDING_WORK = 32;
const DEFAULT_EARLY_WARNING_BAND = 0.3125;
// busy-skip exp-backoff defaults (preserve pre-config behavior: 1s base,
// ×2 per consecutive busy-skip, capped at maxDelayMs).
const DEFAULT_BUSY_SKIP_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BUSY_SKIP_BACKOFF_FACTOR = 2;

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function clampNonNegativeDelayMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function clampOptionalUnitInterval(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    return undefined;
  }
  return value;
}

function clampEarlyWarningBand(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return DEFAULT_EARLY_WARNING_BAND;
  }
  return value;
}

function clampFactor(value: unknown, fallback: number): number {
  // A backoff factor must exceed 1 to actually decay the poll rate.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 1) {
    return fallback;
  }
  return value;
}

function resolveBusySkipBackoff(
  backoff: { baseMs?: number; ceilingMs?: number; factor?: number } | undefined,
  maxDelayMs: number,
): { baseMs: number; ceilingMs: number; factor: number } {
  // Default ceiling is maxDelayMs (the scheduling ceiling) — preserves the
  // pre-config rate-cap. baseMs/factor default to the prior flat 1s ×2.
  return {
    baseMs: clampPositiveInt(backoff?.baseMs, DEFAULT_BUSY_SKIP_BACKOFF_BASE_MS),
    ceilingMs: clampPositiveInt(backoff?.ceilingMs, maxDelayMs),
    factor: clampFactor(backoff?.factor, DEFAULT_BUSY_SKIP_BACKOFF_FACTOR),
  };
}

/**
 * Resolve the continuation runtime config from the gateway config.
 *
 * Called at each enforcement point (scheduling, chain check, cost check, etc.)
 * so hot-reloaded config values take effect at the next decision.
 */
export function resolveContinuationRuntimeConfig(
  cfg: OpenClawConfig = getRuntimeConfig(),
): ContinuationRuntimeConfig {
  const continuation = cfg.agents?.defaults?.continuation;
  const maxDelayMs = clampNonNegativeDelayMs(
    continuation?.maxDelayMs,
    DEFAULT_CONTINUATION_MAX_DELAY_MS,
  );

  return {
    enabled: continuation?.enabled === true,
    defaultDelayMs: clampNonNegativeDelayMs(
      continuation?.defaultDelayMs,
      DEFAULT_CONTINUATION_DELAY_MS,
    ),
    minDelayMs: clampNonNegativeDelayMs(
      continuation?.minDelayMs,
      DEFAULT_CONTINUATION_MIN_DELAY_MS,
    ),
    maxDelayMs,
    maxChainLength: clampPositiveInt(
      continuation?.maxChainLength,
      DEFAULT_CONTINUATION_MAX_CHAIN_LENGTH,
    ),
    costCapTokens: clampNonNegativeInt(
      continuation?.costCapTokens,
      DEFAULT_CONTINUATION_COST_CAP_TOKENS,
    ),
    maxDelegatesPerTurn: clampPositiveInt(
      continuation?.maxDelegatesPerTurn,
      DEFAULT_CONTINUATION_MAX_DELEGATES_PER_TURN,
    ),
    maxPendingWork: clampPositiveInt(
      continuation?.maxPendingWork,
      DEFAULT_CONTINUATION_MAX_PENDING_WORK,
    ),
    contextPressureThreshold: clampOptionalUnitInterval(continuation?.contextPressureThreshold),
    earlyWarningBand: clampEarlyWarningBand(continuation?.earlyWarningBand),
    crossSessionTargeting:
      continuation?.crossSessionTargeting === "enabled" ? "enabled" : "disabled",
    busySkipBackoff: resolveBusySkipBackoff(continuation?.busySkipBackoff, maxDelayMs),
    ...(typeof continuation?.orphanReapStaleCutoffMs === "number" &&
    Number.isFinite(continuation.orphanReapStaleCutoffMs) &&
    continuation.orphanReapStaleCutoffMs > 0
      ? { orphanReapStaleCutoffMs: Math.trunc(continuation.orphanReapStaleCutoffMs) }
      : {}),
  };
}

/**
 * Resolve continuation runtime config preferring the active runtime snapshot.
 *
 * `resolveContinuationRuntimeConfig` accepts whatever cfg the caller passes,
 * which is usually a snapshot captured at run construction. That captured
 * snapshot is stale across hot-reloads: a `gateway/reload config change applied`
 * will update the runtime snapshot but the followup-turn already holds the old
 * cfg. Using this helper at per-turn enforcement points (chain caps, cost caps,
 * pressure thresholds, schedule-time delay reads) lets reloaded values take
 * effect at the next decision-point without invalidating already-armed timers
 * or queued retries (docs/design/continue-work-signal-v2.md §6.5
 * in-flight-state invariant).
 */
export function resolveLiveContinuationRuntimeConfig(
  fallbackCfg: OpenClawConfig,
): ContinuationRuntimeConfig {
  return resolveContinuationRuntimeConfig(getRuntimeConfigSnapshot() ?? fallbackCfg);
}

/**
 * Convenience: resolve just the max delegates per turn.
 */
export function resolveMaxDelegatesPerTurn(cfg: OpenClawConfig = getRuntimeConfig()): number {
  return resolveContinuationRuntimeConfig(cfg).maxDelegatesPerTurn;
}

/**
 * Clamp a raw delay value to the configured [minDelayMs, maxDelayMs] range.
 */
export function clampDelayMs(rawMs: number | undefined, config: ContinuationRuntimeConfig): number {
  const requested = rawMs ?? config.defaultDelayMs;
  // an explicit zero (or any non-positive) is the IMMEDIATE sentinel —
  // preserve it instead of flooring to minDelayMs, so the model-facing
  // "delaySeconds: 0 = immediate" contract actually holds. Omitted (undefined)
  // still resolves to defaultDelayMs above (preserving the distinction
  // that an explicit 0 is not the 15s default); only positive delays clamp.
  if (requested <= 0) {
    return 0;
  }
  return Math.max(config.minDelayMs, Math.min(config.maxDelayMs, requested));
}
