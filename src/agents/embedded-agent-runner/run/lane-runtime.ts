import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { CommandLaneSnapshot } from "../../../process/command-queue.js";
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import { isMainSessionRestartRecoveryInputProvenance } from "../../../sessions/input-provenance.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../timeout.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export const EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS = 30_000;
export const EMBEDDED_RUN_LANE_HEARTBEAT_MS = EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS / 2;

export function shouldNoteLaneWait(snapshot: CommandLaneSnapshot): boolean {
  return (
    snapshot.queuedCount > 0 ||
    snapshot.activeCount >= snapshot.maxConcurrent ||
    snapshot.blockedBy != null
  );
}

export async function withEmbeddedRunLaneProgressHeartbeat<T>(
  noteLaneTaskProgress: () => void,
  fn: () => Promise<T>,
): Promise<T> {
  noteLaneTaskProgress();
  const progressInterval = setInterval(noteLaneTaskProgress, EMBEDDED_RUN_LANE_HEARTBEAT_MS);
  progressInterval.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(progressInterval);
    noteLaneTaskProgress();
  }
}

export function resolveEmbeddedRunLaneTimeoutMs(timeoutMs: number): number {
  const defaultLaneTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;
  // Only unusable input falls back to the default agent deadline. "No timeout"
  // arrives as the timer-safe MAX_TIMER sentinel, which the grace helper clamps
  // back to that same maximum, so an unlimited run keeps an unlimited-in-practice
  // no-progress budget instead of silently collapsing to the 48h default.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return defaultLaneTimeoutMs;
  }
  return (
    addTimerTimeoutGraceMs(Math.floor(timeoutMs), EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS) ??
    defaultLaneTimeoutMs
  );
}

export function withEmbeddedRunLaneTimeout(
  opts: CommandQueueEnqueueOptions | undefined,
  laneTaskTimeoutMs: number,
): CommandQueueEnqueueOptions | undefined {
  if (opts?.taskTimeoutMs !== undefined) {
    return opts;
  }
  return { ...opts, taskTimeoutMs: laneTaskTimeoutMs };
}

export function resolveEmbeddedRunSessionQueuePriority(
  trigger: RunEmbeddedAgentParams["trigger"],
  inputProvenance?: RunEmbeddedAgentParams["inputProvenance"],
): CommandQueueEnqueueOptions["priority"] {
  if (isMainSessionRestartRecoveryInputProvenance(inputProvenance)) {
    return "background";
  }
  switch (trigger) {
    case "user":
    case "manual":
      return "foreground";
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "background";
    default:
      return "normal";
  }
}
