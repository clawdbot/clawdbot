// Whole-run deadline math for chat and agent runs, plus per-attempt renewal.
//
// `registerChatAbortController` sizes a run's deadline for ONE attempt
// (`timeoutMs` plus the abort grace). A primary model candidate that burns the
// full timeout therefore leaves every later fallback candidate only the grace
// window: the maintenance sweep aborts it with an external `TimeoutError`, the
// fallback chain stops with no decision line, and the configured tail is never
// tried. Renewing the deadline as each attempt actually starts removes that
// starvation without touching abort attribution or the once-only execution
// guard in `markExecutionStarted`.
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const {
    now,
    timeoutMs,
    graceMs = DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
    minMs = 2 * 60_000,
    maxMs = 24 * 60 * 60_000,
  } = params;
  const safeNow = asDateTimestampMs(now);
  if (safeNow === undefined) {
    return 0;
  }
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const targetDurationMs = boundedTimeoutMs + graceMs;
  const target = resolveExpiresAtMsFromDurationMs(targetDurationMs, { nowMs: safeNow });
  const min = resolveExpiresAtMsFromDurationMs(minMs, { nowMs: safeNow });
  const max = resolveExpiresAtMsFromDurationMs(maxMs, { nowMs: safeNow });
  if (target === undefined || min === undefined || max === undefined) {
    return 0;
  }
  return Math.min(max, Math.max(min, target));
}

export function resolveAgentRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
}): number {
  const graceMs = Math.max(0, params.graceMs ?? DEFAULT_CHAT_RUN_ABORT_GRACE_MS);
  return resolveChatRunExpiresAtMs({
    now: params.now,
    timeoutMs: params.timeoutMs,
    graceMs,
    minMs: graceMs,
    maxMs: Math.max(0, params.timeoutMs) + graceMs,
  });
}

/**
 * Extends the run deadline for `runId` because a new model attempt is starting.
 *
 * Returns false when the registration is gone, superseded, already aborted, not
 * executing yet, already past its deadline, or when the recomputed deadline
 * would not be later than the current one. The deadline is only ever extended,
 * never shortened, and an entry the sweep has already condemned is never
 * revived.
 */
export function renewChatRunExecutionDeadline(params: {
  entries: Map<string, ChatAbortControllerEntry>;
  runId: string;
  controller: AbortController;
  timeoutMs: number;
  now?: number;
}): boolean {
  const entry = params.entries.get(params.runId);
  if (entry?.controller !== params.controller || params.controller.signal.aborted) {
    return false;
  }
  if (entry.executionStarted !== true) {
    return false;
  }
  const now = params.now ?? Date.now();
  if (!isFutureDateTimestampMs(entry.expiresAtMs, { nowMs: now })) {
    return false;
  }
  const nextExpiresAtMs = resolveAgentRunExpiresAtMs({ now, timeoutMs: params.timeoutMs });
  if (nextExpiresAtMs <= entry.expiresAtMs) {
    return false;
  }
  entry.expiresAtMs = nextExpiresAtMs;
  return true;
}
