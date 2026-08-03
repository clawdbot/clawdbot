/**
 * Subagent run timeout math.
 *
 * Separates timer-safe delays from duration/deadline values because setTimeout has stricter bounds.
 */
import {
  asDateTimestampMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "../shared/number-coercion.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRunDeadlineRecord = Pick<
  SubagentRunRecord,
  "collect" | "createdAt" | "runTimeoutSeconds"
> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt">;
};

/** Convert subagent timeout seconds to a timer-safe delay. */
export function resolveSubagentRunTimerDelayMs(timeoutSeconds: unknown): number | undefined {
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, { floorSeconds: true });
}

/** Convert subagent timeout seconds to a finite millisecond duration. */
export function resolveSubagentRunDurationMs(timeoutSeconds: unknown): number | undefined {
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return undefined;
  }
  const durationMs = Math.floor(timeoutSeconds) * 1000;
  return Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : undefined;
}

/** Resolve the absolute timeout deadline for a subagent run. */
export function resolveSubagentRunDeadlineMs(
  entry: SubagentRunDeadlineRecord,
  observedStartedAt?: number,
): number | undefined {
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  if (durationMs === undefined) {
    return undefined;
  }
  const startedAt =
    typeof observedStartedAt === "number" && Number.isFinite(observedStartedAt)
      ? observedStartedAt
      : typeof entry.execution.startedAt === "number" && Number.isFinite(entry.execution.startedAt)
        ? entry.execution.startedAt
        : entry.collect
          ? undefined
          : entry.createdAt;
  const safeStartedAt = asDateTimestampMs(startedAt);
  if (safeStartedAt === undefined) {
    return undefined;
  }
  const deadlineMs = safeStartedAt + durationMs;
  return Number.isSafeInteger(deadlineMs) && asDateTimestampMs(deadlineMs) !== undefined
    ? deadlineMs
    : undefined;
}

/** Clamp a reported terminal time to the run's explicit timeout deadline. */
export function resolveSubagentRunEffectiveEndedAt(
  entry: SubagentRunDeadlineRecord,
  endedAt: number,
  observedStartedAt?: number,
): number {
  const deadlineMs = resolveSubagentRunDeadlineMs(entry, observedStartedAt);
  return deadlineMs !== undefined && endedAt > deadlineMs ? deadlineMs : endedAt;
}
