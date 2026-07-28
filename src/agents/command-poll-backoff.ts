/**
 * Exponential backoff helpers for command-output polling. Session diagnostics
 * use this state to slow no-output polls while resetting promptly on output.
 */
import type { SessionState } from "../logging/diagnostic-session-state.js";

const BACKOFF_SCHEDULE_MS = [5000, 10000, 30000, 60000];

/**
 * Calculate suggested retry delay based on consecutive no-output poll count.
 * Implements exponential backoff schedule: 5s → 10s → 30s → 60s (capped).
 */
function calculateBackoffMs(consecutiveNoOutputPolls: number): number {
  const index = Math.min(consecutiveNoOutputPolls, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[index] ?? 60000;
}

/**
 * Record a command poll and return suggested retry delay.
 * @param state Session state to track polling in
 * @param commandId Unique identifier for the command being polled
 * @param hasNewOutput Whether this poll returned new output
 * @returns Suggested delay in milliseconds before next poll
 */
export function recordCommandPoll(
  state: SessionState,
  commandId: string,
  hasNewOutput: boolean,
): number {
  if (!state.commandPollCounts) {
    state.commandPollCounts = new Map();
  }

  const existing = state.commandPollCounts.get(commandId);
  const now = Date.now();

  if (hasNewOutput) {
    state.commandPollCounts.set(commandId, { count: 0, lastPollAt: now });
    return BACKOFF_SCHEDULE_MS[0] ?? 5000;
  }

  const newCount = (existing?.count ?? -1) + 1;
  state.commandPollCounts.set(commandId, { count: newCount, lastPollAt: now });

  return calculateBackoffMs(newCount);
}

/**
 * Reset poll count for a command (e.g., when command completes).
 */
export function resetCommandPollCount(state: SessionState, commandId: string): void {
  state.commandPollCounts?.delete(commandId);
}

/**
 * Prune stale command poll records (older than 1 hour).
 * Call periodically to prevent memory bloat.
 */
export function pruneStaleCommandPolls(state: SessionState, maxAgeMs = 3600000): void {
  if (!state.commandPollCounts) {
    return;
  }

  const now = Date.now();
  for (const [commandId, data] of state.commandPollCounts.entries()) {
    if (now - data.lastPollAt > maxAgeMs) {
      state.commandPollCounts.delete(commandId);
    }
  }
}
