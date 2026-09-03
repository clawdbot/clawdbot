import {
  addTimerTimeoutGraceMs,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import type { CommandLaneSnapshot } from "../../../process/command-queue.js";
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import { isMainSessionRestartRecoveryInputProvenance } from "../../../sessions/input-provenance.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../timeout.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export const EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS = 30_000;

export function shouldNoteLaneWait(snapshot: CommandLaneSnapshot): boolean {
  return (
    snapshot.queuedCount > 0 ||
    snapshot.activeCount >= snapshot.maxConcurrent ||
    snapshot.blockedBy != null
  );
}

export function resolveEmbeddedRunLaneTimeoutMs(timeoutMs: number): number {
  const defaultLaneTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;
  // "No timeout" resolves to the timer-safe MAX_TIMER sentinel upstream.
  // This is the preflight/legacy idle backstop; a runtime deadline handoff replaces it.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= MAX_TIMER_TIMEOUT_MS) {
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

export function resolveEmbeddedRunSessionLanePolicy(
  trigger: RunEmbeddedAgentParams["trigger"],
  inputProvenance?: RunEmbeddedAgentParams["inputProvenance"],
): {
  priority: CommandQueueEnqueueOptions["priority"];
  canResumeAcrossRotation: boolean;
} {
  let triggerPriority: CommandQueueEnqueueOptions["priority"];
  switch (trigger) {
    case "user":
    case "manual":
      triggerPriority = "foreground";
      break;
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      triggerPriority = "background";
      break;
    default:
      triggerPriority = "normal";
  }
  const isRestartRecovery = isMainSessionRestartRecoveryInputProvenance(inputProvenance);
  // Inter-session work must yield to humans without losing already-admitted
  // user work when the Gateway lifecycle rotates while it waits.
  return {
    priority:
      isRestartRecovery || inputProvenance?.kind === "inter_session"
        ? "background"
        : triggerPriority,
    canResumeAcrossRotation: !isRestartRecovery && triggerPriority === "foreground",
  };
}
