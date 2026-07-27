// Computes deterministic heartbeat schedule phases and due times.
import { createHash } from "node:crypto";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

function resolvePositiveIntervalMs(value: number): number {
  return resolveIntegerOption(value, 1, { min: 1 });
}

function normalizeModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

export function resolveHeartbeatPhaseMs(params: {
  schedulerSeed: string;
  agentId: string;
  intervalMs: number;
}) {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const digest = createHash("sha256").update(`${params.schedulerSeed}:${params.agentId}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}

export function computeNextHeartbeatPhaseDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
}) {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const nowMs = Number.isFinite(params.nowMs) ? Math.floor(params.nowMs) : 0;
  const phaseMs = normalizeModulo(
    Number.isFinite(params.phaseMs) ? Math.floor(params.phaseMs) : 0,
    intervalMs,
  );
  const cyclePositionMs = normalizeModulo(nowMs, intervalMs);
  let deltaMs = normalizeModulo(phaseMs - cyclePositionMs, intervalMs);
  if (deltaMs === 0) {
    deltaMs = intervalMs;
  }
  return nowMs + deltaMs;
}

export function resolveNextHeartbeatDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
  prev?: {
    intervalMs: number;
    phaseMs: number;
    nextDueMs: number;
  };
}) {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const phaseMs = normalizeModulo(
    Number.isFinite(params.phaseMs) ? Math.floor(params.phaseMs) : 0,
    intervalMs,
  );
  const prev = params.prev;
  if (
    prev &&
    prev.intervalMs === intervalMs &&
    prev.phaseMs === phaseMs &&
    prev.nextDueMs > params.nowMs
  ) {
    return prev.nextDueMs;
  }
  return computeNextHeartbeatPhaseDueMs({
    nowMs: params.nowMs,
    intervalMs,
    phaseMs,
  });
}

/**
 * Seek forward through phase-aligned slots until one falls within the active
 * hours window.  Falls back to the raw next slot when no predicate is provided
 * or no in-window slot is found within the seek horizon.
 *
 * The caller binds config/heartbeat into `isActive` so this module stays
 * config-agnostic.  `phaseMs` is unused — alignment is preserved because
 * `startMs` is already phase-aligned and `intervalMs` addition maintains it.
 */
const MAX_SEEK_HORIZON_MS = 7 * 24 * 60 * 60_000;
// Batch in whole-interval multiples of at least 30 seconds. Active-hours
// boundaries have minute granularity, while each sub-30-second batch is less
// than one minute, so every possible active window still contains a probe.
const MIN_SEEK_STEP_MS = 30_000;

export function seekNextActivePhaseDueMs(params: {
  startMs: number;
  intervalMs: number;
  phaseMs: number;
  isActive?: (ms: number) => boolean;
}): number {
  const isActive = params.isActive;
  if (!isActive) {
    return params.startMs;
  }
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const horizonMs = params.startMs + MAX_SEEK_HORIZON_MS;

  // For intervals of at least 30 seconds, inspect every phase candidate. For
  // shorter intervals, phase-aligned batches bound the forward scan at 20,160
  // predicate calls across the exclusive seven-day horizon.
  const multiplier = Math.max(1, Math.ceil(MIN_SEEK_STEP_MS / intervalMs));
  const batchStepMs = intervalMs * multiplier;

  let candidateMs = params.startMs;
  let previousInactiveMs: number | undefined;

  while (candidateMs < horizonMs) {
    if (isActive(candidateMs)) {
      if (previousInactiveMs !== undefined && multiplier > 1) {
        // A sub-minute batch cannot contain a complete minute-granular active
        // window. Binary-search its single inactive→active transition instead
        // of walking every sub-second phase slot backward.
        let inactiveMs = previousInactiveMs;
        let activeMs = candidateMs;
        while (activeMs - inactiveMs > intervalMs) {
          const remainingSteps = (activeMs - inactiveMs) / intervalMs;
          const probeMs = inactiveMs + Math.floor(remainingSteps / 2) * intervalMs;
          if (isActive(probeMs)) {
            activeMs = probeMs;
          } else {
            inactiveMs = probeMs;
          }
        }
        return activeMs;
      }
      return candidateMs;
    }
    previousInactiveMs = candidateMs;
    candidateMs += batchStepMs;
  }

  // No in-window slot found; fall back so the runtime guard can gate it.
  return params.startMs;
}
