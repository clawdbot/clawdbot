import { isFastTestRuntimeEnv } from "../infra/env.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  failedSpawnCleanupTerminalError,
  markSpawnFailureCleanupTerminalState,
} from "./subagent-registry-helpers.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import { resolveProvisionalSessionCleanupProof } from "./subagent-spawn-cleanup.js";

const SESSION_RUN_TTL_MS = 5 * 60_000;
const FAILED_SPAWN_CLEANUP_RETRY_COOLDOWN_MS = 5 * 60_000;

type ReconcileSpawnFailureCleanupParams = {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  storeCache: SubagentSessionStoreCache;
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist: (...runIds: string[]) => void;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  deleteSession: (
    childSessionKey: string,
    identity?: ProvisionalSessionCleanupIdentity,
  ) => Promise<unknown>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

function markSpawnFailureCleanupDeleted(params: ReconcileSpawnFailureCleanupParams) {
  const { entry, now, runId } = params;
  markSpawnFailureCleanupTerminalState(entry, {
    now,
    status: "deleted",
    error: "subagent spawn failed before startup and cleanup deleted the provisional session",
  });
  params.resumedRuns.delete(runId);
  params.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  entry.archiveAtMs ??= now + SESSION_RUN_TTL_MS;
  entry.deleteCleanupDispatchedAt ??= now;
  emitSessionLifecycleEvent({
    sessionKey: entry.childSessionKey,
    reason: "delete",
    parentSessionKey: entry.controllerSessionKey ?? entry.requesterSessionKey,
  });
}

function markSpawnFailureCleanupGone(
  params: ReconcileSpawnFailureCleanupParams,
  status: "missing" | "replaced",
) {
  const { entry, now, runId } = params;
  markSpawnFailureCleanupTerminalState(entry, {
    now,
    status,
    error: failedSpawnCleanupTerminalError(status),
  });
  params.resumedRuns.delete(runId);
  params.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  entry.archiveAtMs ??= now + SESSION_RUN_TTL_MS;
}

function failedSpawnCleanupRetryCooldownMs(): number {
  return isFastTestRuntimeEnv() ? 1 : FAILED_SPAWN_CLEANUP_RETRY_COOLDOWN_MS;
}

export async function reconcileSpawnFailureCleanup(
  params: ReconcileSpawnFailureCleanupParams,
): Promise<boolean> {
  const { entry, now, runId } = params;
  const cleanup = entry.spawnFailureCleanup;
  if (!cleanup || typeof entry.cleanupCompletedAt === "number") {
    return false;
  }
  let sessionEntry;
  try {
    sessionEntry = loadSubagentSessionEntry({
      childSessionKey: entry.childSessionKey,
      storeCache: params.storeCache,
      storePath: entry.execution.transcriptTarget?.storePath,
    });
  } catch (error) {
    cleanup.lastAttemptAt = now;
    cleanup.lastError = error instanceof Error ? error.message : String(error);
    params.warn("failed to inspect quarantined failed-spawn child session", {
      runId,
      childSessionKey: entry.childSessionKey,
      error,
    });
    return true;
  }
  const cleanupWarnMeta = { runId, childSessionKey: entry.childSessionKey };
  if (cleanup.sessionIdentity) {
    const cleanupProof = resolveProvisionalSessionCleanupProof(
      sessionEntry,
      cleanup.sessionIdentity,
    );
    if (cleanupProof === "missing") {
      if (typeof entry.deleteCleanupDispatchedAt === "number") {
        markSpawnFailureCleanupDeleted(params);
      } else {
        markSpawnFailureCleanupGone(params, "missing");
      }
      params.warn(
        "failed-spawn cleanup found missing child session; released stale quarantine",
        cleanupWarnMeta,
      );
      return true;
    }
    if (cleanupProof === "replacement") {
      markSpawnFailureCleanupGone(params, "replaced");
      params.warn(
        "failed-spawn cleanup found reused child session key; released stale quarantine",
        cleanupWarnMeta,
      );
      return true;
    }
  }
  const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
    notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
  });
  if (completion) {
    cleanup.status = "terminal_registered";
    cleanup.lastAttemptAt = now;
    cleanup.nextAttemptAt = undefined;
    await params.completeSubagentRunWithRecovery(
      {
        runId,
        startedAt: completion.startedAt,
        endedAt: completion.endedAt,
        outcome: completion.outcome,
        reason: completion.reason,
        sendFarewell: false,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: false,
        suppressSessionEffects: true,
      },
      "sweeper-spawn-failure-cleanup-session-completion",
    );
    const latest = params.runs.get(runId);
    if (
      latest?.childSessionKey === entry.childSessionKey &&
      latest.spawnFailureCleanup?.status === "terminal_registered" &&
      typeof latest.cleanupCompletedAt !== "number"
    ) {
      latest.cleanupHandled = true;
      latest.cleanupCompletedAt = now;
      latest.archiveAtMs ??= now + SESSION_RUN_TTL_MS;
      params.persist(runId);
    }
    return true;
  }
  if (!sessionEntry && cleanup.attempts >= cleanup.maxAttempts) {
    markSpawnFailureCleanupDeleted(params);
    return true;
  }
  if (cleanup.status === "deleted") {
    return false;
  }
  if (typeof cleanup.nextAttemptAt === "number" && cleanup.nextAttemptAt > now) {
    return false;
  }
  if (cleanup.status === "exhausted") {
    cleanup.status = "pending";
    cleanup.attempts = 0;
  }
  cleanup.attempts += 1;
  cleanup.lastAttemptAt = now;
  try {
    await params.deleteSession(entry.childSessionKey, cleanup.sessionIdentity);
    markSpawnFailureCleanupDeleted(params);
    return true;
  } catch (error) {
    cleanup.lastError = error instanceof Error ? error.message : String(error);
    if (cleanup.attempts >= cleanup.maxAttempts) {
      cleanup.status = "exhausted";
      cleanup.nextAttemptAt = now + failedSpawnCleanupRetryCooldownMs();
      params.warn("failed-spawn cleanup exhausted; retaining active quarantine", {
        runId,
        childSessionKey: entry.childSessionKey,
        attempts: cleanup.attempts,
        error,
      });
    } else {
      cleanup.nextAttemptAt = now + (isFastTestRuntimeEnv() ? 1 : 1_000);
    }
    return true;
  }
}
