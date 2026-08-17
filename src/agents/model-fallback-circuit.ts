/** Bounds repeated transient failures for one provider/model fallback route. */
import { performance } from "node:perf_hooks";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { describeFailoverError } from "./failover-error.js";
import type { FailoverReason } from "./failover/signal.js";
import { modelKey } from "./model-ref-shared.js";

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
const INITIAL_OPEN_MS = 2 * 60_000;
const MAX_OPEN_MS = 15 * 60_000;
const STATE_TTL_MS = 24 * 60 * 60_000;
const MAX_TRACKED_ROUTES = 256;
const HOST_SATURATION_ELU = 0.9;
const HOST_SATURATION_SAMPLE_MS = 5_000;
const SUPPRESSION_LOG_INTERVAL_MS = 30_000;

const CIRCUIT_FAILURE_REASONS = new Set<FailoverReason>([
  "rate_limit",
  "overloaded",
  "server_error",
  "timeout",
  "empty_response",
]);

type ModelCircuitState = {
  failures: number[];
  openUntil: number;
  currentOpenMs: number;
  halfOpenInFlight: boolean;
  lastTouchedAt: number;
  lastReason: FailoverReason;
  /** Bumped on every open/close transition so stale probes can be detected. */
  generation: number;
};

export type ModelCircuitAttempt = {
  key: string;
  wasHalfOpen: boolean;
  /** State generation observed when this attempt was acquired. */
  generation: number;
};

/**
 * Last-route recovery probes are allowed to overlap, so two attempts can be
 * in flight for the same route. Each carries the generation it observed; a
 * completion whose generation no longer matches has been superseded and must
 * not mutate state, otherwise an older probe can delete or reopen the result
 * a newer probe just recorded.
 */
function isStaleAttempt(attempt: ModelCircuitAttempt): boolean {
  const state = modelCircuitStates.get(attempt.key);
  return state !== undefined && state.generation !== attempt.generation;
}

function currentGeneration(key: string): number {
  return modelCircuitStates.get(key)?.generation ?? 0;
}

type ModelCircuitGate =
  | { type: "attempt"; attempt: ModelCircuitAttempt }
  | { type: "open"; error: string; reason: FailoverReason };

const log = createSubsystemLogger("model-fallback");
const modelCircuitStates = new Map<string, ModelCircuitState>();

// While the local event loop is saturated, in-flight provider calls get
// classified as timeouts regardless of provider health (observed in
// production: every configured route "timed out" within 100ms of each other
// while the providers were returning HTTP 200 in 2-12s). Counting those
// self-inflicted timeouts opens circuits for healthy routes, so they are
// excluded while a rolling event-loop-utilization sample is at or above the
// threshold. Real provider faults (overloaded, rate_limit, server_error)
// still count on a saturated host.
type EluSample = {
  at: number;
  snapshot: ReturnType<typeof performance.eventLoopUtilization>;
  recent: number;
};
let eluSample: EluSample | undefined;

function defaultHostSaturationProbe(now: number): boolean {
  try {
    if (typeof performance.eventLoopUtilization !== "function") {
      return false;
    }
    if (!eluSample) {
      eluSample = { at: now, snapshot: performance.eventLoopUtilization(), recent: 0 };
      return false;
    }
    if (now - eluSample.at >= HOST_SATURATION_SAMPLE_MS) {
      const recent = performance.eventLoopUtilization(eluSample.snapshot).utilization;
      eluSample = { at: now, snapshot: performance.eventLoopUtilization(), recent };
    }
    return eluSample.recent >= HOST_SATURATION_ELU;
  } catch {
    return false;
  }
}

let hostSaturationProbe: (now: number) => boolean = defaultHostSaturationProbe;
let lastSuppressionLogAt = 0;

function shouldLogSuppression(now: number): boolean {
  if (now - lastSuppressionLogAt < SUPPRESSION_LOG_INTERVAL_MS) {
    return false;
  }
  lastSuppressionLogAt = now;
  return true;
}

function circuitKey(provider: string, model: string, agentDir?: string): string {
  return JSON.stringify([normalizeOptionalString(agentDir) ?? "", modelKey(provider, model)]);
}

function trimFailures(state: ModelCircuitState, now: number): void {
  const cutoff = now - FAILURE_WINDOW_MS;
  state.failures = state.failures.filter((timestamp) => timestamp > cutoff);
}

function pruneCircuitStates(now: number): void {
  for (const [key, state] of modelCircuitStates) {
    if (now - state.lastTouchedAt > STATE_TTL_MS) {
      modelCircuitStates.delete(key);
    }
  }
}

function findOldestInactiveStateKey(now: number): string | undefined {
  let oldestKey: string | undefined;
  let oldestTouchedAt = Number.POSITIVE_INFINITY;
  for (const [key, state] of modelCircuitStates) {
    if (state.openUntil > now || state.halfOpenInFlight) {
      continue;
    }
    if (state.lastTouchedAt < oldestTouchedAt) {
      oldestKey = key;
      oldestTouchedAt = state.lastTouchedAt;
    }
  }
  return oldestKey;
}

function reserveStateCapacity(key: string, now: number): boolean {
  pruneCircuitStates(now);
  if (modelCircuitStates.has(key) || modelCircuitStates.size < MAX_TRACKED_ROUTES) {
    return true;
  }
  // Active circuits own their recovery lease. Dropping one here could admit a
  // second concurrent probe, so leave the new route untracked when all are active.
  const evictableKey = findOldestInactiveStateKey(now);
  return evictableKey ? modelCircuitStates.delete(evictableKey) : false;
}

function formatOpenError(state: ModelCircuitState, now: number): string {
  if (state.halfOpenInFlight) {
    return "Model circuit recovery probe already in progress";
  }
  const retrySeconds = Math.max(1, Math.ceil((state.openUntil - now) / 1000));
  return `Model circuit open after repeated ${state.lastReason} failures (retry in ${retrySeconds}s)`;
}

export function acquireModelCircuit(params: {
  provider: string;
  model: string;
  agentDir?: string;
  now?: number;
}): ModelCircuitGate {
  const now = params.now ?? Date.now();
  const key = circuitKey(params.provider, params.model, params.agentDir);
  pruneCircuitStates(now);
  const state = modelCircuitStates.get(key);
  if (!state || state.openUntil <= 0) {
    return {
      type: "attempt",
      attempt: { key, wasHalfOpen: false, generation: currentGeneration(key) },
    };
  }
  if (state.openUntil > now || state.halfOpenInFlight) {
    return { type: "open", error: formatOpenError(state, now), reason: state.lastReason };
  }
  state.halfOpenInFlight = true;
  state.lastTouchedAt = now;
  return { type: "attempt", attempt: { key, wasHalfOpen: true, generation: state.generation } };
}

/**
 * Last-runnable-route probe: grants an attempt even when the circuit is open.
 * Used only when every remaining fallback candidate is blocked before
 * transport (auth skip-cache, cooldown, TLS) — skipping would guarantee a
 * failed turn with zero attempts, which is strictly worse than probing the
 * degraded route. The attempt carries half-open semantics so a success closes
 * the circuit and a failure re-opens it with backoff. A concurrent recovery
 * probe may exist; that is acceptable for the same reason.
 */
export function acquireModelCircuitLastRouteProbe(params: {
  provider: string;
  model: string;
  agentDir?: string;
  now?: number;
}): ModelCircuitAttempt {
  const now = params.now ?? Date.now();
  const key = circuitKey(params.provider, params.model, params.agentDir);
  const state = modelCircuitStates.get(key);
  if (!state || state.openUntil <= now) {
    return { key, wasHalfOpen: false, generation: currentGeneration(key) };
  }
  state.halfOpenInFlight = true;
  state.lastTouchedAt = now;
  return { key, wasHalfOpen: true, generation: state.generation };
}

export function releaseModelCircuitAttempt(attempt: ModelCircuitAttempt | undefined): boolean {
  if (!attempt || isStaleAttempt(attempt)) {
    return false;
  }
  const state = attempt.wasHalfOpen ? modelCircuitStates.get(attempt.key) : undefined;
  if (!state) {
    return false;
  }
  state.halfOpenInFlight = false;
  return true;
}

/**
 * Closes the route in place rather than deleting it. The entry is what lets a
 * superseded probe notice its generation is stale; deleting it would make an
 * older completion look fresh and let it resurrect the route. Idle entries are
 * reclaimed by the TTL/capacity pruner.
 */
function closeCircuit(state: ModelCircuitState, now: number): void {
  state.failures = [];
  state.openUntil = 0;
  state.currentOpenMs = 0;
  state.halfOpenInFlight = false;
  state.lastTouchedAt = now;
  state.generation += 1;
}

function recordModelCircuitSuccess(attempt: ModelCircuitAttempt, now = Date.now()): boolean {
  if (!attempt.wasHalfOpen || isStaleAttempt(attempt)) {
    return false;
  }
  const state = modelCircuitStates.get(attempt.key);
  if (!state) {
    return false;
  }
  closeCircuit(state, now);
  return true;
}

function openCircuit(state: ModelCircuitState, now: number, wasHalfOpen: boolean): void {
  state.currentOpenMs = wasHalfOpen
    ? Math.min(Math.max(state.currentOpenMs, INITIAL_OPEN_MS) * 2, MAX_OPEN_MS)
    : INITIAL_OPEN_MS;
  state.openUntil = now + state.currentOpenMs;
  state.halfOpenInFlight = false;
  state.failures = [];
  state.generation += 1;
}

function newCircuitState(now: number, reason: FailoverReason): ModelCircuitState {
  return {
    failures: [],
    openUntil: 0,
    currentOpenMs: 0,
    halfOpenInFlight: false,
    lastTouchedAt: now,
    lastReason: reason,
    generation: 0,
  };
}

function updateFailureState(state: ModelCircuitState, reason: FailoverReason, now: number): void {
  state.lastTouchedAt = now;
  state.lastReason = reason;
  state.failures.push(now);
  trimFailures(state, now);
}

function clearIneligibleHalfOpen(attempt: ModelCircuitAttempt, now: number): null {
  const state = attempt.wasHalfOpen ? modelCircuitStates.get(attempt.key) : undefined;
  if (state && !isStaleAttempt(attempt)) {
    closeCircuit(state, now);
  }
  return null;
}

function recordModelCircuitFailure(
  attempt: ModelCircuitAttempt,
  reason: FailoverReason | null | undefined,
  now = Date.now(),
): { openMs: number; reason: FailoverReason } | null {
  if (!reason || !CIRCUIT_FAILURE_REASONS.has(reason)) {
    return clearIneligibleHalfOpen(attempt, now);
  }

  if (reason === "timeout" && hostSaturationProbe(now)) {
    // Self-inflicted timeout on a saturated host: release any recovery lease
    // without penalty and do not count the failure.
    releaseModelCircuitAttempt(attempt);
    if (shouldLogSuppression(now)) {
      log.warn("Model circuit ignored timeout failure: host event loop saturated");
    }
    return null;
  }

  if (isStaleAttempt(attempt)) {
    // A newer probe already recorded an outcome for this route.
    return null;
  }
  if (!reserveStateCapacity(attempt.key, now)) {
    return null;
  }
  const state = modelCircuitStates.get(attempt.key) ?? newCircuitState(now, reason);
  updateFailureState(state, reason, now);
  if (attempt.wasHalfOpen || state.failures.length >= FAILURE_THRESHOLD) {
    openCircuit(state, now, attempt.wasHalfOpen);
  }
  modelCircuitStates.set(attempt.key, state);
  return state.openUntil > now ? { openMs: state.currentOpenMs, reason } : null;
}

export function recordCandidateCircuitSuccess(params: {
  attempt: ModelCircuitAttempt | undefined;
  provider: string;
  model: string;
}): void {
  if (!params.attempt || !recordModelCircuitSuccess(params.attempt)) {
    return;
  }
  log.warn(
    `Model circuit closed after recovery for ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.model)}`,
  );
}

export function recordCandidateCircuitFailure(params: {
  attempt: ModelCircuitAttempt | undefined;
  provider: string;
  model: string;
  error: unknown;
}): void {
  if (!params.attempt) {
    return;
  }
  const opened = recordModelCircuitFailure(
    params.attempt,
    describeFailoverError(params.error).reason,
  );
  if (opened) {
    log.warn(
      `Model circuit open for ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.model)} for ${Math.round(opened.openMs / 1000)}s after ${sanitizeForLog(opened.reason)}`,
    );
  }
}

/** @internal – test-only override for the host-saturation probe. */
function setHostSaturationProbeForTests(probe?: (now: number) => boolean): void {
  hostSaturationProbe = probe ?? defaultHostSaturationProbe;
  lastSuppressionLogAt = 0;
}

/** @internal – exposed for focused state-machine tests only. */
export const modelCircuitInternals = {
  modelCircuitStates,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  INITIAL_OPEN_MS,
  MAX_OPEN_MS,
  STATE_TTL_MS,
  MAX_TRACKED_ROUTES,
  HOST_SATURATION_ELU,
  circuitKey,
  pruneCircuitStates,
  recordModelCircuitSuccess,
  recordModelCircuitFailure,
  setHostSaturationProbeForTests,
} as const;
