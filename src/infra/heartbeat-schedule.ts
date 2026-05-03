import { createHash } from "node:crypto";

function normalizeModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

export function resolveHeartbeatPhaseMs(params: {
  schedulerSeed: string;
  agentId: string;
  intervalMs: number;
}) {
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const digest = createHash("sha256").update(`${params.schedulerSeed}:${params.agentId}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}

export function computeNextHeartbeatPhaseDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
}) {
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const nowMs = Math.floor(params.nowMs);
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);
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
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);
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
// Prevent pathological sub-minute intervals from blocking the event loop.
const MAX_SEEK_ITERATIONS = 10_080; // 7 days at 1-minute steps

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
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const horizonMs = params.startMs + MAX_SEEK_HORIZON_MS;
  let candidateMs = params.startMs;
  let iterations = 0;
  while (candidateMs <= horizonMs && iterations < MAX_SEEK_ITERATIONS) {
    if (isActive(candidateMs)) {
      return candidateMs;
    }
    candidateMs += intervalMs;
    iterations++;
  }
  // No in-window slot found; fall back so the runtime guard can gate it.
  return params.startMs;
}
