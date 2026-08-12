import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import type { AcceptedRunTermination } from "./subagent-accepted-run-termination.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type TerminationResult = {
  terminated: boolean;
  sessionCleanupOutcome?: "deleted" | "changed";
};

export async function reconcileAcceptedRunTerminationForSweep(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  termination: AcceptedRunTermination;
  terminate: (
    entry: SubagentRunRecord,
    termination: AcceptedRunTermination,
  ) => Promise<TerminationResult>;
  clearSteerRestart: (runId: string, expected: SubagentRunRecord) => boolean;
  settleFailedLaunch: (
    runId: string,
    error: string,
    options: {
      expectedTermination: AcceptedRunTermination;
      sessionCleanupOutcome?: "deleted" | "changed";
    },
  ) => boolean;
  completeTermination: (runId: string, termination: AcceptedRunTermination) => boolean;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<"continue" | "proceed"> {
  const { runId, entry, termination } = params;
  if (
    termination.phase === "attempted" &&
    isAgentEventLifecycleGenerationCurrent(termination.lifecycleGeneration)
  ) {
    return "continue";
  }
  const result = await params.terminate(entry, termination);
  if (!result.terminated || params.runs.get(runId) !== entry) {
    return "continue";
  }
  if (termination.kind === "steer" && !params.clearSteerRestart(runId, entry)) {
    return "continue";
  }
  if (termination.kind !== "launch") {
    return params.completeTermination(runId, termination) ? "proceed" : "continue";
  }
  try {
    if (
      !params.settleFailedLaunch(runId, "failed launch cleanup resumed", {
        expectedTermination: termination,
        sessionCleanupOutcome: result.sessionCleanupOutcome,
      })
    ) {
      return "continue";
    }
  } catch (error) {
    params.warn("failed to settle terminated launch owner", { runId, error });
    return "continue";
  }
  if (entry.collect) {
    releaseSwarmRun(entry.schedulerSlotId ?? entry.runId);
  }
  return "proceed";
}

export async function reconcileFailedLaunchCleanupForSweep(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  now: number;
  persistOrThrow: (runId: string) => void;
  deleteSession: (
    childSessionKey: string,
    identity: { sessionId: string; lifecycleRevision: string },
  ) => Promise<"deleted" | "changed">;
  settleFailedLaunch: (runId: string, error: string) => boolean;
  cleanupResources: (
    entry: SubagentRunRecord,
    options?: { includeSessionEffects?: boolean },
  ) => Promise<boolean>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<"not-owned" | "pending" | "completed"> {
  const { runId, entry } = params;
  if (!entry.launchCleanupPending) {
    return "not-owned";
  }
  if (entry.execution.status === "queued") {
    try {
      if (!params.settleFailedLaunch(runId, "failed launch cleanup resumed")) {
        return "pending";
      }
    } catch (error) {
      params.warn("failed to terminalize launch cleanup owner", { runId, error });
      return "pending";
    }
    if (params.runs.get(runId) !== entry) {
      return "pending";
    }
    if (entry.collect) {
      releaseSwarmRun(entry.schedulerSlotId ?? entry.runId);
    }
  }
  if (entry.execution.status !== "terminal") {
    return "pending";
  }

  let includeSessionEffects = !shouldSuppressSubagentRecoverySessionEffects(entry);
  let sessionDeleted = false;
  if (entry.launchCleanupSessionOutcome) {
    sessionDeleted = entry.launchCleanupSessionOutcome === "deleted";
    includeSessionEffects &&= sessionDeleted;
  } else if (includeSessionEffects) {
    const identity = entry.launchCleanupSessionIdentity;
    if (!identity) {
      includeSessionEffects = false;
      entry.execution = { ...entry.execution, suppressSessionEffects: true };
    } else {
      let deletion: "deleted" | "changed";
      try {
        deletion = await params.deleteSession(entry.childSessionKey, identity);
      } catch (error) {
        params.warn("failed to retry launch cleanup", {
          runId,
          childSessionKey: entry.childSessionKey,
          error,
        });
        return "pending";
      }
      if (params.runs.get(runId) !== entry) {
        return "pending";
      }
      sessionDeleted = deletion === "deleted";
      if (!sessionDeleted) {
        includeSessionEffects = false;
        entry.execution = { ...entry.execution, suppressSessionEffects: true };
      }
      const previousOutcome = entry.launchCleanupSessionOutcome;
      entry.launchCleanupSessionOutcome = deletion;
      try {
        // Session deletion is irreversible. Persist its exact result before any
        // fallible artifact cleanup so a retry cannot reinterpret a missing session.
        params.persistOrThrow(runId);
      } catch (error) {
        entry.launchCleanupSessionOutcome = previousOutcome;
        params.warn("failed to persist launch cleanup session outcome", { runId, error });
        return "pending";
      }
    }
  }
  if (!(await params.cleanupResources(entry, { includeSessionEffects }))) {
    return "pending";
  }
  if (params.runs.get(runId) !== entry) {
    return "pending";
  }
  if (sessionDeleted) {
    emitSessionLifecycleEvent({
      sessionKey: entry.childSessionKey,
      reason: "delete",
      parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
    });
  }
  entry.launchCleanupPending = undefined;
  entry.launchCleanupSessionIdentity = undefined;
  entry.launchCleanupSessionOutcome = undefined;
  entry.cleanupCompletedAt = params.now;
  return "completed";
}
