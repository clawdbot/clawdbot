// Centralized cooldown decision for heartbeat wakes.
//
// Background: a heartbeat run can be triggered by many wake sources — the
// scheduler's interval tick, a manual user request, a backgrounded `process.start`
// exit, a cron tick, an ACP spawn stream event, etc. Different sources used to
// take different code paths through the dispatcher, and historically the
// `nextDueMs` cooldown gate was only enforced on the `interval` branch. That let
// event-driven wakes (especially `exec-event`) fire heartbeat runs back-to-back
// when a heartbeat agent's tools triggered more wakes (#17797 → #75436).
//
// This module owns the single decision: "given this wake, should we run now or
// defer it?" Both the targeted and broadcast dispatch branches must call
// `shouldDeferWake` so the gate can never be forgotten on one path.

import type { HeartbeatWakeIntent, HeartbeatWakeSource } from "./heartbeat-wake.js";

// Default minimum spacing between heartbeat runs for the same agent, regardless
// of configured `every`. Even when `nextDueMs` is enforced, two wakes arriving
// within milliseconds can race the schedule update; this floor prevents that.
export const DEFAULT_MIN_WAKE_SPACING_MS = 30_000;

// Flood guard: if more than this many wakes for the same agent fall within the
// flood window, the dispatcher logs a warning and forces the wake to defer to
// the next scheduled tick. Tuned so a normal heartbeat that legitimately uses
// `manual` retry doesn't trip it but a feedback loop does.
export const DEFAULT_FLOOD_WINDOW_MS = 60_000;
export const DEFAULT_FLOOD_THRESHOLD = 5;

export type DeferDecision =
  | { defer: false }
  | { defer: true; reason: "not-due" | "min-spacing" | "flood" };

export type ShouldDeferInput = {
  /** Scheduler behavior requested by the wake producer. */
  intent: HeartbeatWakeIntent;
  /** Wake producer, used for diagnostics and future source-specific telemetry. */
  source?: HeartbeatWakeSource;
  /** Raw wake reason string for logs/model context. It does not drive scheduling policy. */
  reason: string | undefined;
  /** Current monotonic-ish wall clock. Pass `Date.now()`. */
  now: number;
  /** When this agent's next interval-tick run is due. */
  nextDueMs: number;
  /** When this agent last *started* a run, if known. */
  lastRunStartedAtMs?: number;
  /** Recent wake timestamps for flood detection. */
  recentRunStarts?: readonly number[];
  /** Override the minimum spacing floor. */
  minSpacingMs?: number;
  /** Override the flood-window length. */
  floodWindowMs?: number;
  /** Override the flood-window threshold. */
  floodThreshold?: number;
};

/**
 * Decide whether an incoming wake should be deferred.
 *
 * The decision matrix:
 *
 * | Wake intent   | First wake (no prior run) | Subsequent wakes                       |
 * |---------------|----------------------------|-----------------------------------------|
 * | manual        | Run                        | Run (never deferred)                    |
 * | immediate     | Run                        | Run (never deferred, except flood)      |
 * | scheduled     | Defer if now < nextDueMs   | Defer if now < nextDueMs                |
 * | event         | Run (bootstrap responsive) | Defer if now < nextDueMs OR within floor |
 *
 * Immediate is for documented wake-now delivery paths such as `openclaw system
 * event --mode now`, task completion follow-ups, cron `--wake now`, and
 * `/hooks/wake mode=now`. Event is for external/system notifications such as
 * background exec exits, node notification changes, hook/cron next-heartbeat
 * handoffs, ACP spawn stream updates, and retry wakes.
 *
 * Additional gates layered on top of the reason matrix:
 *
 *   1. **Minimum spacing floor** (`min-spacing`): even if `nextDueMs` has been
 *      passed, defer if a run started within the last `minSpacingMs`. Catches
 *      the race where a second wake arrives between `runOnce` returning and
 *      `advanceAgentSchedule` updating `nextDueMs`.
 *   2. **Flood guard** (`flood`): if `recentRunStarts` shows ≥ `floodThreshold`
 *      runs within `floodWindowMs`, defer regardless of reason (except
 *      `manual`-class immediate intent). Caller should also emit a single
 *      warning log when this fires.
 */
export function shouldDeferWake(input: ShouldDeferInput): DeferDecision {
  if (input.intent === "manual") {
    return { defer: false };
  }

  if (input.intent === "immediate") {
    // Even immediate wakes get rate-limited if a real flood is happening — but
    // manual operator intent is fully exempt above. System-event, task, hook,
    // and cron wake-now paths come from external systems we trust but cannot
    // prove are loop-free, so the flood guard remains a backstop.
    const floodDefer = checkFloodGuard(input);
    return floodDefer ?? { defer: false };
  }

  // Flood guard applies to every non-immediate wake regardless of run history.
  // It is the last line of defense against feedback loops.
  const floodDefer = checkFloodGuard(input);
  if (floodDefer) {
    return floodDefer;
  }

  if (input.intent === "scheduled") {
    return input.now < input.nextDueMs ? { defer: true, reason: "not-due" } : { defer: false };
  }

  // Event-driven wakes. First wake (no prior run) bypasses cooldown gates so
  // an idle agent can respond to an external event without waiting for the
  // first scheduled phase tick.
  if (input.lastRunStartedAtMs === undefined) {
    return { defer: false };
  }

  if (input.now < input.nextDueMs) {
    return { defer: true, reason: "not-due" };
  }

  const minSpacing = input.minSpacingMs ?? DEFAULT_MIN_WAKE_SPACING_MS;
  if (minSpacing > 0 && input.now - input.lastRunStartedAtMs < minSpacing) {
    return { defer: true, reason: "min-spacing" };
  }

  return { defer: false };
}

function checkFloodGuard(input: ShouldDeferInput): DeferDecision | null {
  const floodWindow = input.floodWindowMs ?? DEFAULT_FLOOD_WINDOW_MS;
  const floodThreshold = input.floodThreshold ?? DEFAULT_FLOOD_THRESHOLD;
  if (!input.recentRunStarts || input.recentRunStarts.length < floodThreshold || floodWindow <= 0) {
    return null;
  }
  const windowStart = input.now - floodWindow;
  let inWindow = 0;
  for (let i = input.recentRunStarts.length - 1; i >= 0; i--) {
    const ts = input.recentRunStarts[i];
    if (ts === undefined || ts < windowStart) {
      break;
    }
    inWindow += 1;
  }
  return inWindow >= floodThreshold ? { defer: true, reason: "flood" } : null;
}

/**
 * Append a run-start timestamp to a bounded recent-runs buffer. Caller passes
 * the previous buffer; this returns a new (mutated) buffer with the entry
 * appended and trimmed to `floodThreshold + 1` entries (only the newest matter
 * for flood detection).
 */
export function recordRunStart(
  buffer: number[],
  ts: number,
  floodThreshold: number = DEFAULT_FLOOD_THRESHOLD,
): number[] {
  buffer.push(ts);
  const max = floodThreshold + 1;
  while (buffer.length > max) {
    buffer.shift();
  }
  return buffer;
}
