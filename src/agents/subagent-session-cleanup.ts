/**
 * Cleanup helper for subagent sessions. It deletes child session state through
 * the gateway and preserves lifecycle-hook behavior for session-mode spawns.
 */
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../config/sessions/lifecycle.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

type CallGateway = typeof defaultCallGateway;
type SubagentSessionCleanupOutcome = "deleted" | "changed" | "failed";

export function isSessionLifecycleChangedGatewayError(error: unknown): boolean {
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

/** Deletes a child subagent session and optionally emits session-mode lifecycle hooks. */
export async function deleteSubagentSessionForCleanup(params: {
  callGateway: CallGateway;
  childSessionKey: string;
  spawnMode?: SpawnSubagentMode;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  onError?: (error: unknown) => void;
}): Promise<SubagentSessionCleanupOutcome> {
  if (!params.expectedSessionId || !params.expectedLifecycleRevision) {
    return "failed";
  }
  try {
    await params.callGateway({
      method: "sessions.delete",
      params: {
        key: params.childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: params.spawnMode === "session",
        ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
        ...(params.expectedLifecycleRevision
          ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
          : {}),
      },
      timeoutMs: 10_000,
    });
    return "deleted";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "changed";
    }
    params.onError?.(error);
    return "failed";
  }
}
