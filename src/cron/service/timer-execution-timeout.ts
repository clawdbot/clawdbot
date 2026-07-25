import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronDeliveryTrace,
  CronJob,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
} from "../types.js";
import type { CronServiceState } from "./state.js";

export const MAX_TIMER_DELAY_MS = 60_000;

export const HEARTBEAT_SKIP_DISABLED = "disabled";

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
export const MIN_REFIRE_GAP_MS = 2_000;

export const DEFAULT_MISSED_JOB_STAGGER_MS = 5_000;

export const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;

export const DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 2 * 60_000;

export type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    job: CronJob;
    taskRunId?: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
    deliveryError?: string;
    delivery?: CronDeliveryTrace;
    isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
    activeJobMarker?: CronActiveJobMarker;
    reservationIdentity?: object;
    startedAt: number;
    endedAt: number;
    triggerEval?: CronTriggerEvalOutcome;
    scriptStateChanged?: boolean;
    scriptState?: unknown;
    nextCheck?: CronNextCheckProposal;
  };

export type CronJobRunResult = CronRunOutcome &
  Pick<CronRunTelemetry, "provider"> & {
    deliveryError?: string;
    delivered?: boolean;
    startedAt: number;
    endedAt: number;
    nextCheck?: CronNextCheckProposal;
  };

export type CronTriggerEvalOutcome = {
  fired: boolean;
  stateChanged: boolean;
  state?: unknown;
  busy?: true;
};

export type IsolatedAgentSetupTimeoutSignal = {
  error: string;
  timeoutMs: number;
  otherCronJobsActiveAtTimeout: boolean;
};

export type IsolatedAgentSetupTimeoutResult = {
  jobId: string;
  job: CronJob;
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};

export type StartupCatchupCandidate = {
  jobId: string;
  job: CronJob;
  reservedAtMs: number;
  reservationIdentity: object;
};

export type StartupDeferredJob = {
  jobId: string;
  delayMs?: number;
};

export type StartupCatchupPlan = {
  candidates: StartupCatchupCandidate[];
  deferredJobs: StartupDeferredJob[];
};

export type StartupCatchupExecution =
  | { ok: true; outcomes: TimedCronRunOutcome[] }
  | { ok: false; outcomes: TimedCronRunOutcome[]; error: unknown };

export type ExecuteJobCoreOptions = {
  activeJobMarker?: CronActiveJobMarker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  streamBatch?: string;
  // Source definition and logical identity are an inseparable admission claim.
  // The key catches edits; the identity catches disable→re-enable and A→B→A.
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
};

/** Script payloads run headlessly even when their notifications target main. */
export function runsDetachedFromMainSession(job: CronJob): boolean {
  return job.sessionTarget !== "main" || job.payload.kind === "script";
}

export function resolveMainSessionCronDeliveryContext(
  state: CronServiceState,
  job: CronJob,
): DeliveryContext | undefined {
  const targetSessionKey = job.sessionKey?.trim();
  if (!targetSessionKey) {
    return undefined;
  }
  const explicitAgentId = job.agentId?.trim();
  const agentId = normalizeAgentId(
    explicitAgentId || resolveAgentIdFromSessionKey(targetSessionKey),
  );
  const storePath = state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
  if (!storePath) {
    return undefined;
  }
  try {
    const sessionEntry = loadSessionEntryReadOnly({
      agentId,
      sessionKey: targetSessionKey,
      storePath,
    });
    return deliveryContextFromSession(sessionEntry);
  } catch {
    return undefined;
  }
}
