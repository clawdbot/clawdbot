/**
 * Cleanup helper for subagent sessions. It deletes child session state through
 * the gateway and preserves lifecycle-hook behavior for session-mode spawns.
 */
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../config/sessions/lifecycle.js";
import type { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

type CallGateway = (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;
type SubagentSessionCleanupOutcome = "deleted" | "changed" | "failed";

function isSessionLifecycleChangedGatewayError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = error as Error & { gatewayCode?: unknown; details?: unknown };
  const details = requestError.details;
  return (
    requestError.gatewayCode === "INVALID_REQUEST" &&
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === SESSION_LIFECYCLE_CHANGED_ERROR_REASON
  );
}

const DEFERRED_SESSION_CLEANUP_RETRY_MS = 5_000;
const DELETE_FAILURE_CLEANUP_RETRIES = 3;
const cleanupRetryTimers = new Map<string, NodeJS.Timeout>();
const log = createSubsystemLogger("agents/subagent-session-cleanup");

type DeleteSubagentSessionForCleanupParams = {
  callGateway: CallGateway;
  childSessionKey: string;
  spawnMode?: SpawnSubagentMode;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
  deleteFailureRetries?: number;
};

function clearDeferredCleanupRetry(childSessionKey: string): void {
  const existing = cleanupRetryTimers.get(childSessionKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing);
  cleanupRetryTimers.delete(childSessionKey);
}

function scheduleDeferredCleanupRetry(params: DeleteSubagentSessionForCleanupParams): void {
  if (cleanupRetryTimers.has(params.childSessionKey)) {
    return;
  }
  const handle = setTimeout(() => {
    cleanupRetryTimers.delete(params.childSessionKey);
    void deleteSubagentSessionForCleanup(params);
  }, DEFERRED_SESSION_CLEANUP_RETRY_MS);
  handle.unref();
  cleanupRetryTimers.set(params.childSessionKey, handle);
}

export function resetSubagentSessionCleanupForTests(): void {
  for (const handle of cleanupRetryTimers.values()) {
    clearTimeout(handle);
  }
  cleanupRetryTimers.clear();
}

/** Deletes a child subagent session and optionally emits session-mode lifecycle hooks. */
export async function deleteSubagentSessionForCleanup(
  params: DeleteSubagentSessionForCleanupParams,
): Promise<SubagentSessionCleanupOutcome> {
  if (!params.expectedSessionId || !params.expectedLifecycleRevision) {
    return "failed";
  }
  const [
    { hasLiveOrRecentlyDispatchedContinuationWork },
    { hasRecoverablePendingDelegate },
    { failStagedPostCompactionDelegatesForCleanup },
    { countActiveDescendantRuns },
  ] = await Promise.all([
    import("../auto-reply/continuation/work-store.js"),
    import("../auto-reply/continuation/delegate-store.js"),
    import("../auto-reply/continuation/delegate-store-post-compaction.js"),
    import("./subagent-registry-runtime.js"),
  ]);
  // A continuation_work TaskFlow, an in-flight regular continuation delegate, or
  // an accepted child run that still uses this session as requester owns
  // same-session re-entry. Keep the child session entry until the remaining work
  // drains, then retry, so delete-mode child sessions do not leak after cleanup
  // bookkeeping finishes AND delayed bracket/tool delegates do not lose the
  // child's chain/requester state to deletion before they finish. The delegate
  // gate must count queued AND `running` (claimed) flows; the registry gate must
  // cover the post-accept window after the TaskFlow row has finished but the
  // spawned continuation still depends on this requester session.
  // Post-compaction rows are failed below only when cleanup is actually going to
  // delete the child: if same-session re-entry is pending, the child may still
  // reach a future compaction seam.

  if (
    hasLiveOrRecentlyDispatchedContinuationWork(params.childSessionKey) ||
    hasRecoverablePendingDelegate(params.childSessionKey) ||
    countActiveDescendantRuns(params.childSessionKey) > 0
  ) {
    scheduleDeferredCleanupRetry(params);
    return "failed";
  }
  const failedPostCompactionDelegates = failStagedPostCompactionDelegatesForCleanup(
    params.childSessionKey,
    "Post-compaction delegate was staged by a delete-mode child session during cleanup; the completed child will not receive a future compaction seam.",
  );
  if (failedPostCompactionDelegates > 0) {
    log.warn(
      `[subagent-session-cleanup-post-compaction-delegates-dropped] child=${params.childSessionKey} count=${failedPostCompactionDelegates}`,
    );
  }

  clearDeferredCleanupRetry(params.childSessionKey);
  try {
    await params.callGateway({
      method: "sessions.delete",
      params: {
        key: params.childSessionKey,
        deleteTranscript: params.deleteTranscript ?? true,
        emitLifecycleHooks: params.emitLifecycleHooks ?? params.spawnMode === "session",
        expectedSessionId: params.expectedSessionId,
        expectedLifecycleRevision: params.expectedLifecycleRevision,
      },
      timeoutMs: params.timeoutMs ?? 10_000,
    });
    return "deleted";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "changed";
    }
    log.warn(
      `[subagent-session-cleanup-delete-failed] child=${params.childSessionKey} error=${error instanceof Error ? error.message : String(error)}`,
    );
    params.onError?.(error);
    const retries = params.deleteFailureRetries ?? 0;
    if (retries < DELETE_FAILURE_CLEANUP_RETRIES) {
      scheduleDeferredCleanupRetry({
        ...params,
        deleteFailureRetries: retries + 1,
      });
    }
    return "failed";
  }
}
