import type { callGateway } from "../gateway/call.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSessionLifecycleChangedGatewayError } from "./subagent-session-cleanup.js";
import {
  loadSubagentSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import { releaseSwarmRun } from "./swarm-scheduler.js";

type FrozenSessionIdentity = {
  sessionId: string;
  lifecycleRevision: string;
};

export function freezeSessionIdentity(
  childSessionKey: string,
  storeCache: SubagentSessionStoreCache,
): FrozenSessionIdentity | undefined {
  const sessionEntry = loadSubagentSessionEntry({ childSessionKey, storeCache });
  const sessionId = sessionEntry?.sessionId?.trim();
  const lifecycleRevision = sessionEntry?.lifecycleRevision?.trim();
  return sessionId && lifecycleRevision ? { sessionId, lifecycleRevision } : undefined;
}

export async function deleteFrozenSession(params: {
  callGateway: typeof callGateway;
  childSessionKey: string;
  identity: FrozenSessionIdentity;
}): Promise<"deleted" | "changed"> {
  try {
    await params.callGateway({
      method: "sessions.delete",
      params: {
        key: params.childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: params.identity.sessionId,
        expectedLifecycleRevision: params.identity.lifecycleRevision,
      },
      timeoutMs: 10_000,
    });
    return "deleted";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "changed";
    }
    throw error;
  }
}

function buildSessionDeleteIdentityParams(identity?: ProvisionalSessionCleanupIdentity) {
  return {
    ...(identity?.expectedSessionId ? { expectedSessionId: identity.expectedSessionId } : {}),
    ...(identity?.expectedLifecycleRevision
      ? { expectedLifecycleRevision: identity.expectedLifecycleRevision }
      : {}),
    ...(typeof identity?.expectedSessionUpdatedAt === "number"
      ? { expectedSessionUpdatedAt: identity.expectedSessionUpdatedAt }
      : {}),
  };
}

export function deleteSpawnFailureSession(params: {
  callGateway: typeof callGateway;
  childSessionKey: string;
  identity?: ProvisionalSessionCleanupIdentity;
}) {
  return params.callGateway({
    method: "sessions.delete",
    params: {
      key: params.childSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
      ...buildSessionDeleteIdentityParams(params.identity),
    },
    timeoutMs: 10_000,
  });
}

export async function reconcileCollectorLaunchCleanup(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  storeCache: SubagentSessionStoreCache;
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (
    entry: SubagentRunRecord,
    options?: { isCurrent?: () => boolean },
  ) => Promise<boolean>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  now: number;
}): Promise<boolean> {
  const isCurrent = () => params.runs.get(params.runId) === params.entry;
  const cleanupResources = async () =>
    await params.cleanupCollectorLaunchResources(params.entry, { isCurrent });
  const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(params.entry);
  if (suppressSessionEffects) {
    if (!(await cleanupResources())) {
      return false;
    }
  } else {
    const sessionIdentity = freezeSessionIdentity(params.entry.childSessionKey, params.storeCache);
    if (!sessionIdentity) {
      params.entry.execution = { ...params.entry.execution, suppressSessionEffects: true };
      if (!(await cleanupResources())) {
        return false;
      }
    } else {
      let deletion: "deleted" | "changed";
      try {
        deletion = await deleteFrozenSession({
          callGateway: params.callGateway,
          childSessionKey: params.entry.childSessionKey,
          identity: sessionIdentity,
        });
      } catch (error) {
        params.warn("failed to retry collector launch cleanup", {
          runId: params.runId,
          childSessionKey: params.entry.childSessionKey,
          error,
        });
        return false;
      }
      if (!isCurrent()) {
        return false;
      }
      if (deletion === "changed") {
        params.entry.execution = { ...params.entry.execution, suppressSessionEffects: true };
      }
      if (!(await cleanupResources())) {
        return false;
      }
      if (!isCurrent()) {
        return false;
      }
      if (deletion === "deleted") {
        emitSessionLifecycleEvent({
          sessionKey: params.entry.childSessionKey,
          reason: "delete",
          parentSessionKey:
            params.entry.swarmRequesterSessionKey ?? params.entry.requesterSessionKey,
        });
      }
    }
  }
  params.entry.collectorLaunchCleanupPending = false;
  params.entry.cleanupCompletedAt = params.now;
  releaseSwarmRun(params.entry.schedulerSlotId ?? params.entry.runId);
  return true;
}
