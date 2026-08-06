/** Bounds repeated transient failures for one provider/model fallback route. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { FailoverReason } from "./embedded-agent-helpers/types.js";
import { describeFailoverError } from "./failover-error.js";
import { modelKey } from "./model-ref-shared.js";

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
const INITIAL_OPEN_MS = 2 * 60_000;
const MAX_OPEN_MS = 15 * 60_000;
const STATE_TTL_MS = 24 * 60 * 60_000;
const MAX_TRACKED_ROUTES = 256;

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
};

export type ModelCircuitAttempt = {
  key: string;
  wasHalfOpen: boolean;
};

type ModelCircuitGate =
  | { type: "attempt"; attempt: ModelCircuitAttempt }
  | { type: "open"; error: string; reason: FailoverReason };

const log = createSubsystemLogger("model-fallback");
const modelCircuitStates = new Map<string, ModelCircuitState>();

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
    return { type: "attempt", attempt: { key, wasHalfOpen: false } };
  }
  if (state.openUntil > now || state.halfOpenInFlight) {
    return { type: "open", error: formatOpenError(state, now), reason: state.lastReason };
  }
  state.halfOpenInFlight = true;
  state.lastTouchedAt = now;
  return { type: "attempt", attempt: { key, wasHalfOpen: true } };
}

export function releaseModelCircuitAttempt(attempt: ModelCircuitAttempt | undefined): boolean {
  const state = attempt?.wasHalfOpen ? modelCircuitStates.get(attempt.key) : undefined;
  if (!state) {
    return false;
  }
  state.halfOpenInFlight = false;
  return true;
}

function recordModelCircuitSuccess(attempt: ModelCircuitAttempt): boolean {
  if (!attempt.wasHalfOpen) {
    return false;
  }
  return modelCircuitStates.delete(attempt.key);
}

function openCircuit(state: ModelCircuitState, now: number, wasHalfOpen: boolean): void {
  state.currentOpenMs = wasHalfOpen
    ? Math.min(Math.max(state.currentOpenMs, INITIAL_OPEN_MS) * 2, MAX_OPEN_MS)
    : INITIAL_OPEN_MS;
  state.openUntil = now + state.currentOpenMs;
  state.halfOpenInFlight = false;
  state.failures = [];
}

function newCircuitState(now: number, reason: FailoverReason): ModelCircuitState {
  return {
    failures: [],
    openUntil: 0,
    currentOpenMs: 0,
    halfOpenInFlight: false,
    lastTouchedAt: now,
    lastReason: reason,
  };
}

function updateFailureState(state: ModelCircuitState, reason: FailoverReason, now: number): void {
  state.lastTouchedAt = now;
  state.lastReason = reason;
  state.failures.push(now);
  trimFailures(state, now);
}

function clearIneligibleHalfOpen(attempt: ModelCircuitAttempt): null {
  if (attempt.wasHalfOpen) {
    modelCircuitStates.delete(attempt.key);
  }
  return null;
}

function recordModelCircuitFailure(
  attempt: ModelCircuitAttempt,
  reason: FailoverReason | null | undefined,
  now = Date.now(),
): { openMs: number; reason: FailoverReason } | null {
  if (!reason || !CIRCUIT_FAILURE_REASONS.has(reason)) {
    return clearIneligibleHalfOpen(attempt);
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

/** @internal – exposed for focused state-machine tests only. */
export const modelCircuitInternals = {
  modelCircuitStates,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  INITIAL_OPEN_MS,
  MAX_OPEN_MS,
  STATE_TTL_MS,
  MAX_TRACKED_ROUTES,
  circuitKey,
  pruneCircuitStates,
  recordModelCircuitSuccess,
  recordModelCircuitFailure,
} as const;
