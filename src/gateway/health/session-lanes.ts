import { getCommandLaneSnapshots } from "../../process/command-queue.js";
import type { SessionLaneHealthSummary } from "./types.js";

export const SESSION_LANE_DEGRADED_AFTER_MS = 15 * 60_000;
export const SESSION_LANE_UNHEALTHY_AFTER_MS = 60 * 60_000;

/** Builds a cheap live health projection for resident per-session command lanes. */
export function buildSessionLaneHealthSummary(now = Date.now()): SessionLaneHealthSummary {
  const lanes = getCommandLaneSnapshots().filter((lane) => lane.lane.startsWith("session:"));
  const activeCount = lanes.reduce((total, lane) => total + lane.activeCount, 0);
  const queuedCount = lanes.reduce((total, lane) => total + lane.queuedCount, 0);
  const idleCount = lanes.filter(
    (lane) => lane.maxConcurrent === 1 && lane.activeCount === 0 && lane.queuedCount === 0,
  ).length;
  const oldestCreatedAt = lanes.reduce<number | undefined>(
    (oldest, lane) =>
      lane.createdAtMs === undefined
        ? oldest
        : oldest === undefined
          ? lane.createdAtMs
          : Math.min(oldest, lane.createdAtMs),
    undefined,
  );
  const oldestQueuedAt = lanes.reduce<number | undefined>(
    (oldest, lane) =>
      lane.oldestQueuedAtMs === undefined
        ? oldest
        : oldest === undefined
          ? lane.oldestQueuedAtMs
          : Math.min(oldest, lane.oldestQueuedAtMs),
    undefined,
  );
  const oldestAgeMs = oldestCreatedAt === undefined ? null : Math.max(0, now - oldestCreatedAt);
  const oldestQueuedAgeMs = oldestQueuedAt === undefined ? null : Math.max(0, now - oldestQueuedAt);
  const status =
    idleCount > 0 ||
    (oldestQueuedAgeMs !== null && oldestQueuedAgeMs >= SESSION_LANE_UNHEALTHY_AFTER_MS)
      ? "unhealthy"
      : oldestQueuedAgeMs !== null && oldestQueuedAgeMs >= SESSION_LANE_DEGRADED_AFTER_MS
        ? "degraded"
        : "healthy";
  return {
    status,
    count: lanes.length,
    activeCount,
    queuedCount,
    idleCount,
    oldestAgeMs,
    oldestQueuedAgeMs,
  };
}
